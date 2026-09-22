#!/usr/bin/env node
/**
 * scripts/summarize-dart.mjs
 *
 * fetch-dart.mjs가 만든 data/dart.json(공시 메타데이터)을 읽어서, "최근 AI_WINDOW_DAYS일 이내"
 * 공시에 한해 DART 원문을 통째로 받아와 Gemini API로 3~5줄 핵심 요약을 붙여줍니다.
 * (전체 공시가 아니라 최근 것만 — 오래된 공시는 지금처럼 메타데이터만 표시되고
 *  competitor_map.html이 "AI 요약 준비 중"으로 자연스럽게 대체해서 보여줍니다.
 *  범위는 처음에 "최근 3개월"로 시작했다가, 이후 "최근 1년"으로 넓혔습니다 — fetch-dart.mjs가
 *  애초에 최근 1년치 공시만 가져오므로, 사실상 "가져온 공시는 전부 요약 대상"이 됩니다.)
 *
 * 실행 순서: update-dart.yml에서 fetch-dart.mjs 다음에 이 스크립트가 이어서 돌아갑니다.
 *   node scripts/fetch-dart.mjs      # data/dart.json 새로 생성(메타데이터만)
 *   node scripts/summarize-dart.mjs # 그중 최근 것만 AI 요약을 붙여서 data/dart.json을 덮어씀
 *
 * 비용/재실행 관리:
 * - data/dart.json은 매일 fetch-dart.mjs가 통째로 새로 만들기 때문에, 요약을 따로
 *   data/dart_summaries.json 에 rcept_no별로 영구 캐싱해둡니다. 이미 요약이 있는 공시는
 *   다시 AI를 부르지 않고 캐시에서 그대로 채워 넣습니다 — 그래서 매일 새로 생기는 소수의
 *   신규 공시에 대해서만 실제 AI 호출이 발생합니다.
 *
 * 키 관리:
 * - DART_API_KEY, GEMINI_API_KEY 모두 이 파일에 쓰지 않고 GitHub Actions Secrets로만 받습니다.
 *
 * 원문 처리 관련 한계(알아두시면 좋은 점):
 * - DART 원문 API(document.xml)는 공시 전체를 ZIP(XML/HTML 혼합 마크업)으로 내려줍니다.
 *   태그를 걷어내 순수 텍스트로 바꾼 뒤 MAX_CHARS로 잘라서 Gemini에 보냅니다.
 *   반기·사업보고서처럼 수백 페이지짜리 문서는 앞부분(회사개요·사업개요 등)이 MAX_CHARS 안에
 *   들어오지만 뒷부분(재무제표 주석, 상세표 등)은 잘려서 요약에 반영되지 않을 수 있습니다.
 *   나중에 필요하면 섹션별로 골라 추출하는 로직으로 개선할 수 있습니다.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const DART_API_KEY = process.env.DART_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 모델명은 구글 쪽에서 자주 바뀝니다 — 실행 시점에 https://ai.google.dev/gemini-api/docs/models
// 에서 현재 사용 가능한 가장 저렴한 flash/flash-lite 계열 모델명으로 맞는지 한 번 확인해주세요.
// 필요하면 워크플로에서 GEMINI_MODEL 환경변수로 덮어쓸 수 있습니다(시크릿일 필요는 없음).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (!DART_API_KEY) {
  console.error('[오류] DART_API_KEY 환경변수가 없습니다.');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('[오류] GEMINI_API_KEY 환경변수가 없습니다.');
  console.error('       GitHub 저장소 Settings > Secrets and variables > Actions 에 등록했는지 확인하세요.');
  process.exit(1);
}

const DART_JSON_PATH = path.resolve('data/dart.json');
const SUMMARY_CACHE_PATH = path.resolve('data/dart_summaries.json');
const AI_WINDOW_DAYS = 365; // 최근 1년 — 그 이전 공시는 요약하지 않고 메타데이터만 유지
// (fetch-dart.mjs의 WINDOW_DAYS도 365라서, 사실상 새로 가져오는 공시는 모두 이 범위 안에 듭니다)
const MAX_CHARS = 40000; // Gemini에 보낼 원문 최대 글자 수(비용/응답시간 관리용)
const EXCERPT_CHARS = 400; // originExcerpt로 보여줄, 원문에서 그대로 뽑은 발췌 길이
const REQUEST_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysAgo(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / 86400000;
}

async function loadJsonSafe(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── DART 원문 다운로드 ────────────────────────────────────────────────
async function downloadDocumentText(rceptNo) {
  const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${encodeURIComponent(DART_API_KEY)}&rcept_no=${encodeURIComponent(rceptNo)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`document.xml 다운로드 실패 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  const head = buf.slice(0, 2).toString('latin1');
  if (head !== 'PK') {
    // 오류 시 ZIP 대신 XML/JSON 오류 메시지가 내려옵니다.
    const msg = buf.toString('utf8');
    throw new Error(`document.xml 응답이 ZIP이 아닙니다: ${msg.slice(0, 200)}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dart-doc-'));
  const zipPath = path.join(tmpDir, 'doc.zip');
  await fs.writeFile(zipPath, buf);
  execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { stdio: 'ignore' });

  const entries = await fs.readdir(tmpDir);
  const textFiles = entries.filter((f) => f.toLowerCase() !== 'doc.zip');

  let combined = '';
  for (const f of textFiles) {
    try {
      const raw = await fs.readFile(path.join(tmpDir, f), 'utf8');
      combined += '\n' + stripMarkup(raw);
    } catch {
      // 일부 첨부가 텍스트가 아닌 경우(이미지 등) 건너뜁니다.
    }
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
  return combined.trim();
}

// DART 원문은 HTML과 유사한 커스텀 마크업(TABLE/TR/TD/P/SPAN 등)을 씁니다 —
// 태그를 제거하고 흔한 엔티티만 풀어서 읽을 수 있는 텍스트로 바꿉니다.
function stripMarkup(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeExcerpt(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > EXCERPT_CHARS ? clean.slice(0, EXCERPT_CHARS) + '…' : clean;
}

// ── Gemini 호출 ──────────────────────────────────────────────────────
async function summarizeWithGemini(companyLabel, title, dateStr, bodyText) {
  const truncated = bodyText.length > MAX_CHARS ? bodyText.slice(0, MAX_CHARS) : bodyText;
  const prompt =
    '당신은 한국 상장기업 공시(전자공시시스템 DART)를 요약하는 애널리스트입니다.\n' +
    '아래 공시 원문의 핵심을 한국어 불릿 3~5개로 요약하세요.\n' +
    '규칙:\n' +
    '- 숫자·금액·비율 등 구체적인 수치를 최대한 포함할 것\n' +
    '- 전년동기/전기 대비 변화가 있으면 명시할 것\n' +
    '- "당사는 다양한 노력을 기울이고 있습니다" 같은 상투적 표현은 쓰지 말 것\n' +
    '- 불릿 하나당 한 문장, 40자 내외로 간결하게 쓸 것\n' +
    '- 이 공시가 "연결" 기준(자회사 실적이 합산된 그룹 전체 수치)이라면, 그 사실을 첫 불릿에서\n' +
    '  분명히 밝힐 것(예: "연결 기준 영업이익 793억원(-8.7%)")\n' +
    '- 원문에 사업부문별(예: 백화점, 면세점, 자회사 등) 또는 자회사별 세부 실적이 연결 전체\n' +
    '  수치와 별도로 나와 있다면, 그 부문별/자회사별 수치도 반드시 별도 불릿으로 구분해서\n' +
    '  포함할 것(예: "[백화점 부문] 영업이익 1,101억원(+58.6%)", "[자회사 지누스] 영업손실 267억원").\n' +
    '  이런 부문별 수치가 원문에 없으면 억지로 만들지 말고 생략할 것\n' +
    '- 반드시 아래 JSON 형식으로만 응답할 것(다른 텍스트, 코드블록 표시 금지):\n' +
    '{"summary": ["...", "...", "..."]}\n\n' +
    `[회사명] ${companyLabel}\n[공시명] ${title}\n[제출일] ${dateStr}\n\n` +
    `[공시 원문(발췌)]\n${truncated}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API 오류 (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.summary) && parsed.summary.length) {
        return parsed.summary.map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
      }
    } catch {
      // JSON 파싱 실패 시 아래 줄바꿈 분리 방식으로 대체
    }
  }
  // JSON 파싱이 안 되면 줄 단위로 나눠서 최대한 활용합니다.
  return text
    .split('\n')
    .map((s) => s.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function main() {
  const dart = await loadJsonSafe(DART_JSON_PATH, null);
  if (!dart || !dart.companies) {
    console.error('[오류] data/dart.json이 없습니다. 먼저 scripts/fetch-dart.mjs를 실행하세요.');
    process.exit(1);
  }

  const cache = await loadJsonSafe(SUMMARY_CACHE_PATH, { items: {} });
  if (!cache.items) cache.items = {};

  let calledCount = 0;
  let skippedOld = 0;
  let cacheHits = 0;
  let errorCount = 0;

  for (const navKey of Object.keys(dart.companies)) {
    const items = dart.companies[navKey] || [];
    for (const item of items) {
      const ageInDays = daysAgo(item.date);
      if (ageInDays > AI_WINDOW_DAYS) {
        skippedOld += 1;
        continue; // 오래된 공시는 AI 요약 대상이 아님 — 메타데이터만 유지
      }

      const cached = cache.items[item.id];
      if (cached && cached.summary && cached.summary.length) {
        item.summary = cached.summary;
        item.originExcerpt = cached.originExcerpt || null;
        cacheHits += 1;
        continue;
      }

      console.log(`요약 생성 중: [${navKey}] ${item.title} (${item.date}, ${item.id})`);
      try {
        const bodyText = await downloadDocumentText(item.id);
        if (!bodyText) throw new Error('원문 텍스트를 추출하지 못했습니다(빈 문서).');
        const summary = await summarizeWithGemini(item.submitter || navKey, item.title, item.date, bodyText);
        const originExcerpt = makeExcerpt(bodyText);

        item.summary = summary;
        item.originExcerpt = originExcerpt;
        cache.items[item.id] = { summary, originExcerpt, generatedAt: new Date().toISOString(), model: GEMINI_MODEL };
        calledCount += 1;
      } catch (err) {
        console.error(`  [오류] ${item.id} 요약 실패: ${err.message}`);
        errorCount += 1;
        item.summary = null;
        item.originExcerpt = null;
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  await fs.writeFile(SUMMARY_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  await fs.writeFile(DART_JSON_PATH, JSON.stringify(dart, null, 2) + '\n', 'utf8');

  console.log(
    `완료: 신규 AI 요약 ${calledCount}건, 캐시 재사용 ${cacheHits}건, 기간 밖(요약 안함) ${skippedOld}건, 실패 ${errorCount}건`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
