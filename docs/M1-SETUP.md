# M1 설정 안내: 유사도 Worker와 실험실

모든 단계를 휴대폰 브라우저로 할 수 있다. 컴퓨터나 터미널은 필요 없다.

## 구성

| 경로 | 내용 |
|---|---|
| `worker/` | Cloudflare Worker. `POST /similarity`로 단어 쌍 유사도를 Claude로 채점한다 |
| `web/lab/` | 유사도 실험실. Opus 5.5와 Haiku 5.5의 점수, 흔들림, 비용을 비교한다 |
| `.github/workflows/` | CI(테스트), Worker 자동 배포, GitHub Pages 자동 배포 |

## 1. Anthropic API 키 준비

1. https://console.anthropic.com 에서 API 키를 만든다.
2. **Settings → Limits에서 월 지출 한도를 낮게(예: $10) 걸어 둔다.** 키가 새더라도 피해가 한도 안에서 멈춘다.

## 2. Cloudflare 준비

1. https://dash.cloudflare.com 에 가입한다 (무료).
2. **계정 ID:** 대시보드 홈 → 오른쪽(모바일은 아래쪽) "Account ID"를 복사한다.
3. **API 토큰:** 오른쪽 위 프로필 → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" 템플릿 → Create.

## 3. GitHub 저장소 설정

1. 저장소 → Settings → Secrets and variables → Actions → New repository secret으로 두 개를 등록한다.
   - `CLOUDFLARE_API_TOKEN`: 2-3의 토큰
   - `CLOUDFLARE_ACCOUNT_ID`: 2-2의 계정 ID
2. 저장소 → Settings → Pages → Source를 **GitHub Actions**로 바꾼다.

## 4. 배포

이 PR을 merge하면 Actions가 자동으로 Worker와 Pages를 배포한다. Actions 탭에서 "Deploy Worker", "Deploy Pages"를 직접 실행할 수도 있다.

- Worker 주소: `https://hidden-word-similarity.<계정 하위도메인>.workers.dev` (Cloudflare 대시보드 → Workers & Pages에서 확인)
- 실험실 주소: `https://jaeminseol.github.io/hidden-word/lab/`

## 5. Worker 비밀값 등록

Cloudflare 대시보드 → Workers & Pages → `hidden-word-similarity` → Settings → Variables and Secrets → Add에서 **Secret** 형식으로 두 개를 등록한다.

- `ANTHROPIC_API_KEY`: 1의 API 키
- `LAB_TOKEN`: 실험실 접근용 비밀번호. 길고 아무도 모르는 문자열로 정한다 (예: 비밀번호 생성기로 만든 30자)

`LAB_TOKEN`이 없으면 Worker는 모든 채점 요청을 거절한다.

## 6. 실험 방법

1. 실험실 주소를 열고 Worker 주소와 `LAB_TOKEN`을 입력한다 (브라우저에만 저장된다).
2. 예시 세트(바다, 학교, 커피, 고유명사 금지/허용)를 하나씩 눌러 채점한다. 기본값은 **캐시 건너뛰기 + 3회 반복**이다.
3. 요약 카드에서 두 모델을 비교한다.
   - **기대 구간 일치:** 사람이 정한 기대 점수 구간에 들어온 비율. 높을수록 좋다.
   - **반복 시 평균 점수 차이:** 같은 쌍을 다시 채점했을 때 흔들린 정도. 낮을수록 좋다. (실제 게임에서는 첫 점수를 캐시해서 흔들림이 사라진다.)
   - **한 판 예상 / 최악:** 측정한 1회 비용 × 150회 / 360회.
4. 결과를 보고 모델을 정한다. 판단 기준 예시: Haiku의 기대 구간 일치가 Opus와 비슷하면 Haiku.

예시 세트 5개를 3회씩 두 모델로 돌리면 약 200회 호출이다. Opus 기준 약 $1, Haiku 기준 몇 센트로 예상된다.

## 단어 쌍 캐시 (선택)

캐시를 켜면 같은 단어 쌍은 처음 받은 점수를 계속 쓴다. M1 실험에는 없어도 된다.

1. Cloudflare 대시보드 → Storage & Databases → KV → Create → 이름 `SIM_CACHE`.
2. 만든 KV의 ID를 `worker/wrangler.toml`의 `[[kv_namespaces]]` 부분에 넣고 주석을 푼다.

KV 무료 요금제는 하루 쓰기 1,000회 제한이 있다. 실제 게임(M3)에서는 캐시를 Firebase로 옮길 예정이다.

## 로컬 개발 (컴퓨터가 있을 때)

```bash
cd worker
npm ci
cp .dev.vars.example .dev.vars   # 키와 토큰을 채운다
npm run dev                       # http://localhost:8787
npm test
# 다른 터미널에서
cd web/lab && python3 -m http.server 8000   # http://localhost:8000
```
