const fs = require('fs');
const path = require('path');

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

// ──────────────────────────────────────────────
// 외부 사이트별 다운로드 핸들러
// ──────────────────────────────────────────────

async function downloadFromScholar(extPage, paper, pdfsDir) {
  // Kyobo Scholar (scholar.kyobobook.co.kr)
  // SPA(Vue) 렌더링 완료 후 "원문저장" 버튼(.btn_type01.down) 클릭
  await extPage.waitForSelector('a.btn_type01.down, a.down', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(1000);

  const [download] = await Promise.all([
    extPage.waitForEvent('download', { timeout: 20000 }),
    extPage.evaluate(() => {
      const btn = document.querySelector('a.btn_type01.down, a.down');
      if (btn) btn.click();
    })
  ]);

  const filename = sanitizeFilename(paper.filename);
  const savePath = path.join(pdfsDir, filename);
  await download.saveAs(savePath);
  return savePath;
}

async function downloadFromKci(extPage, paper, pdfsDir) {
  // KCI (kci.go.kr)
  await extPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(2000);

  const [download] = await Promise.all([
    extPage.waitForEvent('download', { timeout: 20000 }),
    extPage.evaluate(() => {
      // KCI 원문 다운로드 버튼 패턴
      const btn = document.querySelector(
        'a[onclick*="download"], .btn_down, #btnDown, a[href*=".pdf"], ' +
        'button[onclick*="download"], a.btn_fulltext'
      );
      if (btn) btn.click();
    })
  ]);

  const filename = sanitizeFilename(paper.filename);
  const savePath = path.join(pdfsDir, filename);
  await download.saveAs(savePath);
  return savePath;
}

async function downloadFromDbpia(extPage, paper, pdfsDir) {
  // DBpia (dbpia.co.kr) — 테스트 확인: button[onclick*="download"] ("다운받기")
  await extPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(2000);

  const [download] = await Promise.all([
    extPage.waitForEvent('download', { timeout: 20000 }),
    extPage.evaluate(() => {
      const btn = document.querySelector('button[onclick*="download"], a[onclick*="download"]')
        || Array.from(document.querySelectorAll('a, button')).find(el =>
            el.textContent?.trim().match(/다운받기|다운로드|Download/));
      if (btn) btn.click();
    })
  ]);

  const filename = sanitizeFilename(paper.filename);
  const savePath = path.join(pdfsDir, filename);
  await download.saveAs(savePath);
  return savePath;
}

async function downloadFromEarticle(extPage, paper, pdfsDir) {
  // earticle (earticle.net) — 테스트 확인: text "다운로드"
  await extPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(2000);

  const [download] = await Promise.all([
    extPage.waitForEvent('download', { timeout: 20000 }),
    extPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button')).find(el =>
          el.textContent?.trim().match(/다운로드|Download|PDF/))
        || document.querySelector('a[href*="download"], a.pdf_down, button[onclick*="download"]');
      if (btn) btn.click();
    })
  ]);

  const filename = sanitizeFilename(paper.filename);
  const savePath = path.join(pdfsDir, filename);
  await download.saveAs(savePath);
  return savePath;
}

async function downloadFromKiss(extPage, paper, pdfsDir) {
  // KISS (kiss.kstudy.com) — 테스트 확인: text "다운로드"
  await extPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(2000);

  const [download] = await Promise.all([
    extPage.waitForEvent('download', { timeout: 20000 }),
    extPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button')).find(el =>
          el.textContent?.trim().match(/다운로드|Download/))
        || document.querySelector('#btnDownload, a[onclick*="download"], .down_btn');
      if (btn) btn.click();
    })
  ]);

  const filename = sanitizeFilename(paper.filename);
  const savePath = path.join(pdfsDir, filename);
  await download.saveAs(savePath);
  return savePath;
}

async function downloadFromRissDirect(extPage, paper, pdfsDir) {
  // RISS 직접 제공 (학위논문 등)
  await extPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(2000);

  const [download] = await Promise.all([
    extPage.waitForEvent('download', { timeout: 20000 }),
    extPage.evaluate(() => {
      const btn = document.querySelector(
        'a[onclick*="download"], #btnFullDown, a.btn_down, a[href*=".pdf"]'
      );
      if (btn) btn.click();
    })
  ]);

  const filename = sanitizeFilename(paper.filename);
  const savePath = path.join(pdfsDir, filename);
  await download.saveAs(savePath);
  return savePath;
}

// 알 수 없는 사이트 - 공통 패턴으로 시도
async function downloadFromGeneric(extPage, paper, pdfsDir) {
  await extPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await extPage.waitForTimeout(3000);

  // 1차 시도: 텍스트 기반 버튼 탐색
  const downloadText = ['원문저장', '원문다운로드', 'PDF 다운', 'PDF다운', 'Download', '다운로드'];
  for (const text of downloadText) {
    try {
      const [download] = await Promise.all([
        extPage.waitForEvent('download', { timeout: 8000 }),
        extPage.evaluate((t) => {
          const els = Array.from(document.querySelectorAll('a, button'));
          const btn = els.find(el => el.textContent?.includes(t));
          if (btn) btn.click();
          return !!btn;
        }, text)
      ]);
      const filename = sanitizeFilename(paper.filename);
      const savePath = path.join(pdfsDir, filename);
      await download.saveAs(savePath);
      return savePath;
    } catch {
      // 다음 시도
    }
  }

  // 2차 시도: href에 .pdf 포함된 링크 직접 클릭
  try {
    const pdfUrl = await extPage.evaluate(() => {
      const link = document.querySelector('a[href$=".pdf"], a[href*=".pdf?"]');
      return link?.href || null;
    });
    if (pdfUrl) {
      const [download] = await Promise.all([
        extPage.waitForEvent('download', { timeout: 10000 }),
        extPage.evaluate((url) => {
          const a = document.querySelector(`a[href="${url}"]`);
          if (a) a.click();
        }, pdfUrl)
      ]);
      const filename = sanitizeFilename(paper.filename);
      const savePath = path.join(pdfsDir, filename);
      await download.saveAs(savePath);
      return savePath;
    }
  } catch {
    // 실패
  }

  return null;
}

// ──────────────────────────────────────────────
// 메인 다운로드 로직
// ──────────────────────────────────────────────

async function attemptDownload(context, rissPage, paper, pdfsDir) {
  // 상세 페이지로 이동
  await rissPage.goto(paper.detailUrl);
  await rissPage.waitForTimeout(2000);

  // 버튼 확인: memberUrlDownload(외부 사이트) vs fulltextDownload(RISS 뷰어/DRM)
  await rissPage.waitForSelector(
    'a[onclick*="memberUrlDownload"], a[onclick*="fulltextDownload"]',
    { timeout: 8000 }
  ).catch(() => {});

  const memberBtn = await rissPage.$('a[onclick*="memberUrlDownload"]');
  const fulltextBtn = await rissPage.$('a[onclick*="fulltextDownload"]');

  // memberUrlDownload 없고 fulltextDownload만 있을 때 → 학위논문 DRM
  if (!memberBtn && fulltextBtn) {
    console.log('    (DRM 보호 — 자동 다운로드 불가)');
    return null;
  }

  if (!memberBtn) return null;

  // evaluate()로 클릭해야 onclick 핸들러가 정상 실행됨
  // Promise.all 순서: 이벤트 리스너 먼저 등록 후 클릭
  const extPagePromise = context.waitForEvent('page', { timeout: 20000 });
  await rissPage.evaluate(() => {
    document.querySelector('a[onclick*="memberUrlDownload"]')?.click();
  });
  const extPage = await extPagePromise;

  // UrlLoad.do → 외부 사이트 리다이렉트 완료 대기
  await extPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await extPage.waitForTimeout(3000);

  const extUrl = extPage.url();
  console.log(`    → ${extUrl.split('/').slice(0, 3).join('/')}`);

  let downloadPath = null;
  try {
    if (extUrl.includes('scholar.kyobobook.co.kr')) {
      downloadPath = await downloadFromScholar(extPage, paper, pdfsDir);
    } else if (extUrl.includes('kci.go.kr')) {
      downloadPath = await downloadFromKci(extPage, paper, pdfsDir);
    } else if (extUrl.includes('dbpia.co.kr')) {
      downloadPath = await downloadFromDbpia(extPage, paper, pdfsDir);
    } else if (extUrl.includes('earticle.net')) {
      downloadPath = await downloadFromEarticle(extPage, paper, pdfsDir);
    } else if (extUrl.includes('kiss.kstudy.com') || extUrl.includes('kiss.k')) {
      downloadPath = await downloadFromKiss(extPage, paper, pdfsDir);
    } else if (extUrl.includes('riss.kr')) {
      downloadPath = await downloadFromRissDirect(extPage, paper, pdfsDir);
    } else {
      downloadPath = await downloadFromGeneric(extPage, paper, pdfsDir);
    }
  } catch (err) {
    console.log(`    ✗ 다운로드 실패 (${extUrl.split('/')[2]}): ${err.message}`);
  }

  await extPage.close().catch(() => {});
  return downloadPath;
}

async function downloadPapers(context, rissPage, papers, pdfsDir) {
  console.log(`\nPDF 다운로드 시작 (${papers.length}개)`);
  const results = [];

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    console.log(`  [${i + 1}/${papers.length}] ${paper.title.substring(0, 40)}...`);

    if (!paper.downloadOnclick) {
      console.log('    원문 미제공');
      results.push({ ...paper, downloadStatus: 'no_link' });
      continue;
    }

    try {
      const filepath = await attemptDownload(context, rissPage, paper, pdfsDir);
      if (filepath) {
        console.log(`    ✓ 저장: ${path.basename(filepath)}`);
        results.push({ ...paper, filePath: path.join('pdfs', path.basename(filepath)), downloadStatus: 'success' });
      } else if (filepath === null) {
        // null = DRM 보호 또는 버튼 없음 (오류 아님)
        results.push({ ...paper, downloadStatus: 'no_link' });
      } else {
        console.log('    ✗ 다운로드 실패');
        results.push({ ...paper, downloadStatus: 'failed' });
      }
    } catch (err) {
      console.error(`    ✗ 오류: ${err.message}`);
      results.push({ ...paper, downloadStatus: 'error', downloadError: err.message });
    }

    await rissPage.waitForTimeout(1000);
  }

  const success = results.filter(r => r.downloadStatus === 'success').length;
  const noLink = results.filter(r => r.downloadStatus === 'no_link').length;
  const failed = results.filter(r => r.downloadStatus !== 'success' && r.downloadStatus !== 'no_link').length;
  console.log(`\n다운로드 완료: 성공 ${success} / 원문없음 ${noLink} / 실패 ${failed}`);
  return results;
}

async function runDownload(rissPage, metadataPath, pdfsDir) {
  const papers = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const withDownload = papers.filter(p => p.downloadOnclick);
  console.log(`원문 다운로드 가능: ${withDownload.length}/${papers.length}개`);

  const context = rissPage.context();
  const results = await downloadPapers(context, rissPage, papers, pdfsDir);

  fs.writeFileSync(metadataPath, JSON.stringify(results, null, 2), 'utf8');
  return results;
}

module.exports = { runDownload, downloadPapers };
