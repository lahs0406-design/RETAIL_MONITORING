#!/usr/bin/env node
/**
 * 매일 1회 GitHub Actions에서 실행되어(스케줄: .github/workflows/update-dart.yml),
 * 전자공시시스템(DART, OpenDART Open API)에서 유통사별 공시 목록을 가져와
 * data/dart.json 에 저장합니다.
 *
 * - DART_API_KEY는 절대 이 파일에 쓰지 않고, GitHub Actions Secrets(DART_API_KEY)로만 전달받습니다.
 * - 아직 AI 요약 기능은 붙지 않았습니다(사용자가 "일단 레이아웃/샘플 유지"를 먼저 선택했고,
 *   이후 "DART API 키부터 연동"을 진행 중인 단계). 그래서 이 스크립트가 만드는 data/dart.json에는
 *   원문 링크(originUrl)와 공시 메타데이터만 들어있고 summary/originExcerpt는 없습니다.
 *   competitor_map.html은 이 필드가 없으면 "AI 요약 준비 중" 문구로 자연스럽게 대체해서 보여줍니다.
 * - 회사명 -> corp_code 매칭: DART는 이름으로 직접 검색하는 API가 없어서, 매일
 *   corpCode.xml(전체 법인 목록, ZIP)을 내려받아 그 안에서 이름을 찾습니다.
 *   완전일치를 우선 시도하고, 실패하면 부분일치로 재시도하며 그 경우 결과에 uncertain 표시를 남깁니다.
 *   매칭 결과는 data/dart_corp_codes.json 에도 별도로 저장해서 사람이 확인할 수 있게 합니다.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const DART_API_KEY = process.env.DART_API_KEY;

if (!DART_API_KEY) {
  console.error('[오류] DART_API_KEY 환경변수가 없습니다.');
  console.error('       GitHub 저장소 Settings > Secrets and variables > Actions 에 등록했는지 확인하세요.');
  process.exit(1);
}

const OUTPUT_PATH = path.resolve('data/dart.json');
const CORP_CACHE_PATH = path.resolve('data/dart_corp_codes.json');
const WINDOW_DAYS = 365; // 정기보고서(사업보고서 등)까지 포함해서 넉넉하게 최근 1년
const PAGE_COUNT = 100;  // list.json 페이지당 최대 100건
const REQUEST_DELAY_MS = 150;

// 회사 nav key(competitor_map.html의 COMPANY_NAV[].key와 동일) -> 실제 공시법인 후보 이름들.
// 첫 번째가 가장 유력한 정식 법인명이고, 나머지는 표기 변형/구 상호명 후보입니다.
// 실제 매칭 결과는 실행할 때마다 data/dart_corp_codes.json에서 확인하고,
// 틀렸으면 이 목록만 고쳐서 다시 실행하면 됩니다(코드 로직 변경 불필요).
const COMPANY_CANDIDATES = {
  hyundai: ['현대백화점'],
  shinsegae: ['신세계'],
  lotte: ['롯데쇼핑'],
  galleria: ['한화갤러리아', '한화갤러리아타임월드'],
  ak: ['애경자산관리', 'AK플라자'],
  ikea: ['이케아코리아'],
  starfield: ['신세계프라퍼티'],
  musinsa: ['무신사'],
  oliveyoung: ['CJ올리브영', '올리브영'],
  daiso: ['아성다이소'],
};

// pblntf_ty(공시유형 대분류 코드) -> 지도 페이지의 DART_TYPES 키.
// DART 대분류에는 "실적·전망"이 따로 없어서, report_nm에 특정 키워드가 있으면
// 대분류와 무관하게 earnings로 우선 분류합니다(잠정실적/공정공시 등).
const TYPE_MAP = { A: 'periodic', B: 'major', C: 'etc', D: 'holder', E: 'etc', F: 'etc', G: 'etc', H: 'etc', I: 'etc', J: 'etc' };
const EARNINGS_KEYWORDS = ['잠정실적', '실적공시', '매출액또는손익구조', '공정공시'];

function classifyType(pblntfTy, reportNm) {
  if (EARNINGS_KEYWORDS.some((k) => reportNm.indexOf(k) !== -1)) return 'earnings';
  return TYPE_MAP[pblntfTy] || 'etc';
}

// 경영권·자본변동 등 특히 주목할 만한 공시인지 — 키워드 기반 간단 판정(주요사항보고는 항상 포함).
const IMPORTANT_KEYWORDS = ['최대주주', '경영권', '주식담보', '타법인', '합병', '분할', '유상증자', '전환사채', '신주인수권'];
function isImportant(reportNm, type) {
  if (type === 'major') return true;
  return IMPORTANT_KEYWORDS.some((k) => reportNm.indexOf(k) !== -1);
}

function normalizeName(s) {
  return String(s || '')
    .replace(/\(주\)/g, '')
    .replace(/주식회사/g, '')
    .replace(/\(유\)/g, '')
    .replace(/유한회사/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function downloadCorpCodeXml() {
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(DART_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`corpCode.xml 다운로드 실패 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  // DART는 키 오류 등이 있으면 ZIP 대신 JSON 오류 메시지를 줍니다 — 먼저 시그니처로 확인합니다.
  const head = buf.slice(0, 2).toString('latin1');
  if (head !== 'PK') {
    const msg = buf.toString('utf8');
    throw new Error(`corpCode.xml 응답이 ZIP이 아닙니다(API 키 오류일 수 있음): ${msg.slice(0, 300)}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dart-corpcode-'));
  const zipPath = path.join(tmpDir, 'corpCode.zip');
  await fs.writeFile(zipPath, buf);
  execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { stdio: 'ignore' });
  const xmlPath = path.join(tmpDir, 'CORPCODE.xml');
  const xml = await fs.readFile(xmlPath, 'utf8');
  await fs.rm(tmpDir, { recursive: true, force: true });
  return xml;
}

// <list><corp_code>.../<corp_name>.../<stock_code>.../<modify_date>...</list> 가 반복되는
// 단순한 구조라, 별도 XML 라이브러리 없이 정규식으로 안전하게 추출합니다.
function parseCorpList(xml) {
  const items = [];
  const listRe = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = listRe.exec(xml))) {
    const block = m[1];
    const field = (tag) => {
      const fm = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return fm ? fm[1].trim() : '';
    };
    items.push({
      corp_code: field('corp_code'),
      corp_name: field('corp_name'),
      stock_code: field('stock_code'),
      modify_date: field('modify_date'),
    });
  }
  return items;
}

function matchCorpCode(candidates, corpList) {
  const normCandidates = candidates.map(normalizeName);

  // 1차: 정규화 후 완전일치
  for (const nc of normCandidates) {
    const hit = corpList.find((c) => normalizeName(c.corp_name) === nc);
    if (hit) return { corp_code: hit.corp_code, corp_name: hit.corp_name, stock_code: hit.stock_code, uncertain: false };
  }

  // 2차: 부분일치 — 여러 개 걸리면 상장사(stock_code 있음)를 우선하고, uncertain으로 표시
  for (const nc of normCandidates) {
    const hits = corpList.filter((c) => normalizeName(c.corp_name).indexOf(nc) !== -1);
    if (hits.length) {
      hits.sort((a, b) => (b.stock_code ? 1 : 0) - (a.stock_code ? 1 : 0));
      return { corp_code: hits[0].corp_code, corp_name: hits[0].corp_name, stock_code: hits[0].stock_code, uncertain: true };
    }
  }

  return null;
}

async function fetchDisclosures(corpCode, bgnDe, endDe) {
  const all = [];
  let page = 1;
  for (;;) {
    const url =
      `https://opendart.fss.or.kr/api/list.json?crtfc_key=${encodeURIComponent(DART_API_KEY)}` +
      `&corp_code=${encodeURIComponent(corpCode)}&bgn_de=${bgnDe}&end_de=${endDe}` +
      `&page_no=${page}&page_count=${PAGE_COUNT}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === '013') break; // 조회된 데이터가 없습니다(정상)
    if (data.status !== '000') {
      console.error(`  [경고] list.json 오류 (status=${data.status}): ${data.message}`);
      break;
    }
    all.push(...(data.list || []));
    if (page >= (data.total_page || 1)) break;
    page += 1;
    await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

async function main() {
  console.log('DART 고유번호(corp_code) 전체 목록을 내려받는 중...');
  const xml = await downloadCorpCodeXml();
  const corpList = parseCorpList(xml);
  console.log(`  총 ${corpList.length}개 법인 확인`);

  const warnings = [];
  const resolved = {};
  for (const navKey of Object.keys(COMPANY_CANDIDATES)) {
    const match = matchCorpCode(COMPANY_CANDIDATES[navKey], corpList);
    if (!match) {
      warnings.push(`${navKey}: 후보 이름(${COMPANY_CANDIDATES[navKey].join(', ')})으로 법인을 찾지 못했습니다.`);
      continue;
    }
    resolved[navKey] = match;
    if (match.uncertain) {
      warnings.push(`${navKey}: "${match.corp_name}"(corp_code ${match.corp_code})로 부분일치 매칭됨 — 확인 필요.`);
    }
  }

  await fs.mkdir(path.dirname(CORP_CACHE_PATH), { recursive: true });
  await fs.writeFile(
    CORP_CACHE_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), resolved, warnings }, null, 2) + '\n',
    'utf8'
  );

  const end = new Date();
  const begin = new Date(end.getTime() - WINDOW_DAYS * 86400000);
  const bgnDe = fmtDate(begin);
  const endDe = fmtDate(end);

  const result = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    warnings: warnings.slice(),
    companies: {},
  };

  for (const navKey of Object.keys(COMPANY_CANDIDATES)) {
    const match = resolved[navKey];
    if (!match) {
      result.companies[navKey] = [];
      continue;
    }
    console.log(`조회 중: ${navKey} (${match.corp_name}, ${match.corp_code})`);
    let list;
    try {
      list = await fetchDisclosures(match.corp_code, bgnDe, endDe);
    } catch (err) {
      console.error(`  [오류] ${navKey} 공시 조회 실패: ${err.message}`);
      result.warnings.push(`${navKey}: 공시 조회 중 오류 - ${err.message}`);
      result.companies[navKey] = [];
      continue;
    }
    result.companies[navKey] = list.map((item) => {
      const type = classifyType(item.pblntf_ty, item.report_nm || '');
      const dateStr = (item.rcept_dt || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      return {
        id: item.rcept_no,
        type,
        important: isImportant(item.report_nm || '', type),
        title: item.report_nm,
        submitter: item.flr_nm,
        date: dateStr,
        originUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
      };
    });
    await sleep(REQUEST_DELAY_MS);
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`완료: ${OUTPUT_PATH} 저장`);

  if (warnings.length) {
    console.log('--- 확인이 필요한 항목 ---');
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
