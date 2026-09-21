#!/usr/bin/env node
/**
 * 매일 1회 GitHub Actions에서 실행되어(스케줄: .github/workflows/update-news.yml),
 * competitor_map.html 안의 REGIONS 데이터에서 매장 목록을 그대로 뽑아
 * 매장 이름 하나하나로 네이버 뉴스 검색 API를 호출하고, 결과를 data/news.json 에 저장합니다.
 *
 * - 매장 목록을 이 스크립트 안에 따로 복사해두지 않고, competitor_map.html의
 *   `var REGIONS = {...}` 를 직접 읽어서 사용합니다. 그래서 지도에 매장을 추가/삭제하면
 *   다음 실행부터 자동으로 반영됩니다(별도로 이 스크립트를 고칠 필요 없음).
 * - Naver Client ID/Secret은 절대 이 파일에 쓰지 않고, GitHub Actions Secrets
 *   (NAVER_CLIENT_ID, NAVER_CLIENT_SECRET)로만 전달받습니다.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error('[오류] NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없습니다.');
  console.error('       GitHub 저장소 Settings > Secrets and variables > Actions 에 등록했는지 확인하세요.');
  process.exit(1);
}

const HTML_PATH = path.resolve('competitor_map.html');
const OUTPUT_PATH = path.resolve('data/news.json');
const MAX_PER_STORE = 6;      // 매장당 최대 저장 기사 수
const WINDOW_DAYS = 60;       // 이 기간(일)보다 오래된 기사는 저장하지 않음
const REQUEST_DELAY_MS = 150; // 네이버 API 과호출 방지용 호출 간 대기 시간

// 매장별 별칭: 기사에서 정식 상호명 대신 줄여서/다르게 쓰는 경우를 위한 보조 이름입니다.
// 검색(Naver 쿼리)과 매칭(제목·요약에 실제로 포함됐는지 검증) 양쪽 모두에 함께 쓰입니다.
// store id는 competitor_map.html의 REGIONS에 있는 id와 동일해야 합니다.
// 필요한 매장만 추가하면 되고, 없는 매장은 원래 상호명(name)만 그대로 사용합니다.
const STORE_ALIASES = {
  'hd-muyeok': ['현대 무역센터점', '현대백화점 무역점'],
  // 예) 'ikea-gangdong': ['이케아 강동', '이케아 강동구'],

  // 갤러리아 (기사에서 "갤러리아백화점"만 쓰거나 지점명을 줄여 쓰는 경우가 많음)
  'ga-apgujeong':  ['갤러리아 명품관', '갤러리아백화점 압구정'],
  'ga-timeworld':  ['갤러리아백화점 타임월드'],
  'ga-centercity': ['갤러리아백화점 센터시티', '갤러리아 천안'],
  'ga-jinju':      ['갤러리아백화점 진주점'],
  'ga-gwanggyo':   ['갤러리아백화점 광교'],

  // AK플라자 (백화점형/AK& 몰형 모두 "AK플라자"로 통칭되는 경우가 많음)
  'ak-bundang':      ['AK플라자 분당'],
  'ak-suwon':        ['AK플라자 수원'],
  'ak-pyeongtaek':   ['AK플라자 평택'],
  'ak-giheung':      ['AK플라자 기흥', 'AK 기흥'],
  'ak-gwangmyeong':  ['AK플라자 광명', 'AK 광명'],
  'ak-geumjeong':    ['AK플라자 금정', 'AK 금정', 'AK 군포'],
  'ak-sejong':       ['AK플라자 세종', 'AK 세종'],
  'ak-hongdae':      ['AK플라자 홍대', 'AK 홍대'],
  'ak-airport':      ['AK플라자 인천공항'],

  // 다이소 (플래그십/대형매장은 보통 "다이소 OO점"으로 정식 표기됨)
  'daiso-myeongdong': ['다이소 명동'],
  'daiso-gangnam':    ['다이소 강남역'],
  'daiso-hongdae':    ['다이소 홍대'],
  'daiso-seongsu':    ['다이소 성수'],
};

function stripHtml(s) {
  return String(s || '')
    .replace(/<\/?b>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

// 실제 뉴스 제목을 간단한 키워드 규칙으로 오픈·팝업·세일·사은행사·기타 5개 분류에 매핑합니다.
// (지도 페이지의 기존 카테고리 체계와 동일하게 맞춰서, 필터 UI가 그대로 작동하도록 함)
const CATEGORY_RULES = [
  { key: 'open', words: ['오픈', '개점', '재개장', '리뉴얼', '그랜드오픈', '증축', '개장', '출점'] },
  { key: 'popup', words: ['팝업', '편집숍', '입점', '단독', '체험형', '플래그십'] },
  { key: 'sale', words: ['세일', '할인', '특가', '시즌오프', '균일가', '프로모션'] },
  { key: 'gift', words: ['사은', '경품', '멤버십', '증정', '혜택', '이벤트'] },
];
function classify(title) {
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => title.includes(w))) return rule.key;
  }
  return 'etc';
}

function isWithinWindow(pubDate, days) {
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() >= Date.now() - days * 24 * 60 * 60 * 1000;
}

// 네이버 뉴스 검색은 정확한 구문 일치 검색이 아니라 "관련도" 기반 검색이라서,
// "현대백화점 무역센터점"처럼 검색해도 기사 수가 적으면 다른 지점(킨텍스점 등) 기사가
// 섞여 나올 수 있습니다. 그래서 검색 결과 중 "실제로 이 매장 이름이 제목/요약에
// 그대로 들어있는" 기사만 남기는 재검증 필터를 둡니다(공백 차이는 무시).
function compact(s) {
  return String(s || '').replace(/\s+/g, '');
}
function matchesStore(title, description, storeName) {
  const haystack = compact(title) + compact(description);
  return haystack.includes(compact(storeName));
}
// names 배열(정식 상호명 + 별칭) 중 하나라도 제목/요약에 포함되면 그 매장의 기사로 인정합니다.
function matchesAnyName(title, description, names) {
  return names.some((n) => matchesStore(title, description, n));
}

function extractStores(html) {
  const startMarker = 'var REGIONS = ';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error('competitor_map.html에서 "var REGIONS = " 를 찾지 못했습니다.');
  const endIdx = html.indexOf('var REAL_REGION_KEYS', startIdx);
  if (endIdx === -1) throw new Error('competitor_map.html에서 REGIONS 데이터의 끝 지점을 찾지 못했습니다.');

  let objText = html.slice(startIdx + startMarker.length, endIdx).trim();
  if (objText.endsWith(';')) objText = objText.slice(0, -1);

  // REGIONS는 우리가 직접 관리하는 신뢰된 파일 내용이므로 eval로 파싱합니다(외부 입력 아님).
  // eslint-disable-next-line no-eval
  const REGIONS = (0, eval)('(' + objText + ')');

  const stores = [];
  for (const key of Object.keys(REGIONS)) {
    for (const s of REGIONS[key].stores) {
      stores.push({ id: s.id, name: s.name, company: s.company, region: key });
    }
  }
  return stores;
}

async function fetchNewsFor(storeName) {
  // display를 넉넉히 받아온 뒤(아래에서 매장명 재검증 필터로 걸러내므로),
  // 필터를 통과하는 기사 수가 줄어도 MAX_PER_STORE를 최대한 채울 수 있게 합니다.
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(storeName)}&display=30&sort=date`;
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    },
  });
  if (!res.ok) {
    console.error(`[경고] "${storeName}" 조회 실패 (HTTP ${res.status})`);
    return [];
  }
  const data = await res.json();
  return data.items || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const html = await fs.readFile(HTML_PATH, 'utf8');
  const stores = extractStores(html);
  console.log(`매장 ${stores.length}개에 대해 네이버 뉴스 검색을 시작합니다. (윈도우: 최근 ${WINDOW_DAYS}일, 매장당 최대 ${MAX_PER_STORE}건)`);

  const result = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    stores: {},
  };

  let doneCount = 0;
  for (const store of stores) {
    const names = [store.name, ...(STORE_ALIASES[store.id] || [])];

    // 별칭이 있는 매장은 이름별로 각각 검색해서 합칩니다(같은 기사는 링크로 중복 제거).
    const itemsByLink = new Map();
    for (const name of names) {
      const items = await fetchNewsFor(name);
      for (const it of items) {
        const key = it.originallink || it.link;
        if (key && !itemsByLink.has(key)) itemsByLink.set(key, it);
      }
      if (names.length > 1) await sleep(REQUEST_DELAY_MS);
    }
    const items = [...itemsByLink.values()];

    const alerts = items
      .filter((it) => isWithinWindow(it.pubDate, WINDOW_DAYS))
      .filter((it) => matchesAnyName(stripHtml(it.title), stripHtml(it.description), names))
      .slice(0, MAX_PER_STORE)
      .map((it) => {
        const title = stripHtml(it.title);
        let sourceHost = '';
        try {
          sourceHost = new URL(it.originallink || it.link).hostname.replace(/^www\./, '');
        } catch {
          sourceHost = '';
        }
        return {
          title,
          link: it.originallink || it.link,
          source: sourceHost || '네이버뉴스',
          pubDate: it.pubDate,
          category: classify(title),
        };
      });
    result.stores[store.id] = alerts;
    doneCount += 1;
    if (doneCount % 20 === 0) console.log(`  ... ${doneCount}/${stores.length} 완료`);
    await sleep(REQUEST_DELAY_MS);
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`완료: ${OUTPUT_PATH} 저장 (매장 ${stores.length}개)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
