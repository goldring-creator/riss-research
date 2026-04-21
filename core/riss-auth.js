// 도서관 로그인 + RISS 접속 — 배포용 (자격증명 파라미터 방식)
async function loginAndGetRiss(context, creds = {}) {
  const libraryId = creds.libraryId || process.env.RISS_ID;
  const libraryPw = creds.libraryPw || process.env.RISS_PW;

  if (!libraryId || !libraryPw) {
    throw new Error('도서관 ID/PW가 설정되지 않았습니다. 앱 화면에서 저장하세요.');
  }

  const page = await context.newPage();

  await page.goto('https://lib.hufs.ac.kr/login?returnUrl=%3F&queryParamsHandling=merge');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  await page.fill('input[placeholder*="이용자ID"]', libraryId);
  await page.fill('input[placeholder*="이용자PW"]', libraryPw);
  await page.locator('#content button[type="submit"]').click();
  await page.waitForTimeout(5000);
  try {
    await page.waitForURL(url => !url.includes('login'), { timeout: 60000 });
  } catch { /* 계속 진행 */ }

  if (page.url().includes('login')) throw new Error('도서관 로그인 실패 — ID/PW를 확인하세요.');
  console.log('도서관 로그인 성공');

  const rissLink = await page.$('a[href*="riss"]');
  if (!rissLink) throw new Error('RISS 링크를 찾을 수 없습니다');

  const [rissPage] = await Promise.all([
    context.waitForEvent('page'),
    rissLink.click()
  ]);
  await rissPage.waitForTimeout(5000);
  try {
    await rissPage.waitForLoadState('domcontentloaded', { timeout: 60000 });
  } catch { /* 타임아웃 무시 */ }

  if (!rissPage.url().includes('riss.kr')) throw new Error('RISS 접속 실패');
  console.log('RISS 접속 성공:', rissPage.url());

  await page.close();
  return rissPage;
}

module.exports = { loginAndGetRiss };
