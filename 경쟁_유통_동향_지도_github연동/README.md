# 경쟁 유통 동향 지도 — 네이버 뉴스 API 연동 설정

이 저장소를 GitHub에 올리고 아래 순서대로 설정하면, 매일 1회 자동으로 매장 107개 각각의 최신 뉴스를 네이버 뉴스 검색 API에서 가져와 지도 페이지에 실제 데이터로 표시합니다.

## 폴더 구성

```
competitor_map.html          지도 페이지 본체 (GitHub Pages로 그대로 공개 가능)
data/news.json               매일 자동 갱신되는 매장별 실제 뉴스 데이터 (처음엔 비어있음)
scripts/fetch-news.mjs        네이버 뉴스 API를 호출해 data/news.json을 만드는 스크립트
.github/workflows/update-news.yml   위 스크립트를 매일 1회 자동 실행하는 GitHub Actions 설정
```

## 설정 순서

### 1. 네이버 오픈API 키 발급
1. [developers.naver.com](https://developers.naver.com) 로그인 → 애플리케이션 등록
2. 사용 API로 **검색** 선택
3. 발급된 **Client ID**, **Client Secret** 확보 (이 두 값은 절대 코드에 직접 넣지 않습니다)

### 2. GitHub 저장소 준비
1. 이 폴더 전체를 새 GitHub 저장소에 업로드(또는 `git init` 후 push)
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret** 에서 아래 2개를 등록
   - `NAVER_CLIENT_ID` = 위에서 받은 Client ID
   - `NAVER_CLIENT_SECRET` = 위에서 받은 Client Secret

### 3. GitHub Pages 켜기 (지도 페이지를 URL로 보고 싶다면)
1. 저장소 **Settings → Pages**
2. Source를 "Deploy from a branch"로, 브랜치는 `main` (또는 사용 중인 기본 브랜치), 폴더는 `/ (root)`로 지정
3. 몇 분 후 `https://계정명.github.io/저장소명/competitor_map.html` 형태의 주소로 접속 가능
   - 루트 주소(`https://계정명.github.io/저장소명/`)로 바로 열고 싶다면 `competitor_map.html`을 `index.html`로 이름만 바꾸면 됩니다.

### 4. 첫 데이터 수집 수동 실행
Actions 자동 스케줄(매일 06:00 KST)을 기다리지 않고 바로 확인하고 싶다면:
1. 저장소 **Actions** 탭 → **Update store news (Naver)** 워크플로 선택
2. **Run workflow** 버튼 클릭 → 실행
3. 1~2분 후 완료되면 `data/news.json`이 자동으로 커밋되고, 지도 페이지를 새로고침하면 실제 뉴스가 표시됩니다

## 동작 방식 요약

- `scripts/fetch-news.mjs`는 매번 실행될 때마다 `competitor_map.html` 안의 매장 목록(REGIONS 데이터)을 직접 읽어서 사용합니다. 그래서 나중에 지도에 매장을 추가/삭제해도 스크립트를 따로 손댈 필요가 없습니다.
- 매장 이름으로 네이버 뉴스를 검색하고, 최근 30일 이내 기사만, 매장당 최대 6건까지 저장합니다.
- 기사 제목에 포함된 키워드(오픈/팝업/세일/사은행사 등)로 자동 분류해서 기존 필터 UI와 그대로 맞물립니다.
- 지도 페이지는 켜질 때 `data/news.json`을 우선 불러오고, 파일이 없거나 비어있으면(첫 배포 직후 등) 자동으로 기존 더미 데이터로 대체 표시합니다 — 화면이 깨지지 않습니다.
- 페이지 상단 배지에 "실연동 중" 또는 "연동 전(더미)" 상태가 표시됩니다.

## 참고: claude.ai에 게시된 미리보기 링크에서는 왜 안 뜨나요?

claude.ai 아티팩트 미리보기는 보안 정책상 자체 도메인 안의 `data/news.json` 같은 상대 경로 파일도 GitHub Pages처럼 같은 출처로 취급되지 않아서 이 방식이 그대로 작동하지 않습니다. 실제 서비스는 **이 저장소를 GitHub Pages(또는 사내 웹서버)에 올린 주소**를 기준으로 확인해주세요.
