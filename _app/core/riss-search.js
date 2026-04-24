const fs = require('fs');
const path = require('path');

const PROVIDER_PRIORITY = {
  'kci': 1, 'kci.go.kr': 1,
  '스콜라': 2, 'scholar': 2, 'kyobo': 2,
  'kiss': 3, 'dbpia': 4, 'earticle': 5,
  '원문보기': 6, 'default': 7,
};

function getProviderPriority(providerName) {
  if (!providerName) return PROVIDER_PRIORITY.default;
  const lower = providerName.toLowerCase();
  for (const [key, val] of Object.entries(PROVIDER_PRIORITY)) {
    if (lower.includes(key)) return val;
  }
  return PROVIDER_PRIORITY.default;
}

function extractKoreanName(authorStr) {
  return authorStr.split('(')[0].trim();
}

function buildFilename({ authorDisplay, year, title, journal, volume, issue, pages }) {
  const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '').trim();
  const journalKo = journal ? journal.replace(/\s*\([^)]*[a-zA-Z][^)]*\)\s*$/, '').trim() : '';
  let name = `${authorDisplay}(${year}). ${cleanTitle}`;
  if (journalKo) {
    name += `. ${journalKo.replace(/[\\/:*?"<>|]/g, '').trim()}`;
    if (volume && issue) name += `, ${volume}(${issue})`;
    else if (volume) name += `, ${volume}`;
    if (pages) name += `, ${pages}`;
  }
  const enc = new TextEncoder();
  let bytes = enc.encode(name);
  if (bytes.length > 251) {
    let cut = 251;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    name = new TextDecoder().decode(bytes.slice(0, cut)).trimEnd();
  }
  return `${name}.pdf`;
}

// Phase A: 검색 결과 목록에서 링크만 수집 (rissPage 독점 사용)
async function collectListItems(rissPage, keyword, maxPages, filters, pageOffset, totalPages) {
  const { yearFrom, yearTo, kciOnly, sortBy } = filters;
  console.log(`\n검색 키워드: "${keyword}" (최대 ${maxPages}페이지)`);

  let searchUrl = `https://www.riss.kr/search/Search.do?isDetailSearch=N&searchGubun=true&viewYn=OP&query=${encodeURIComponent(keyword)}&colName=re_a_kor&p_mat_type=1a0202e37d52c72d`;
  if (yearFrom) searchUrl += `&p_year1=${yearFrom}`;
  if (yearTo) searchUrl += `&p_year2=${yearTo}`;
  if (kciOnly) searchUrl += `&regnm=KCI%EB%93%B1%EC%9E%AC`;

  const sortMap = { newest: 'DATE', rank: 'RANK', popular: 'VIEWCOUNT' };
  const strSort = sortMap[sortBy] || 'RANK';
  searchUrl += `&strSort=${strSort}&order=/DESC`;

  await rissPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
    return rissPage.goto(searchUrl);
  });
  await rissPage.waitForTimeout(2000);

  const allItems = [];
  const seen = new Set();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const globalPage = pageOffset + pageNum;
    console.log(`  페이지 [${globalPage}/${totalPages}] 링크 수집 중...`);

    const items = await rissPage.$$eval('a[href*="DetailView"]', els =>
      els
        .filter(e => e.textContent?.trim().length > 10)
        .map(e => ({ text: e.textContent.trim(), href: e.href }))
    );

    const uniqueItems = items.filter(item => {
      const match = item.href.match(/control_no=([^&]+)/);
      if (!match) return false;
      if (seen.has(match[1])) return false;
      if (/^Vol\.\s*\d+/.test(item.text.trim())) return false;
      seen.add(match[1]);
      return true;
    });

    console.log(`    ${uniqueItems.length}개 논문 링크 발견`);
    allItems.push(...uniqueItems);

    if (pageNum < maxPages) {
      const nextBtn = await rissPage.$(`a[href*="pageNumber=${pageNum + 1}"]`);
      if (nextBtn) {
        await nextBtn.click();
        await rissPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await rissPage.waitForTimeout(1500);
      } else {
        console.log(`  다음 페이지(${pageNum + 1})가 없습니다.`);
        break;
      }
    }
  }

  return allItems;
}

// Phase B: 상세 페이지를 N개 worker가 병렬로 수집
const DETAIL_CONCURRENCY = 3;

async function fetchDetailsParallel(context, items) {
  const queue = [...items];
  const papers = [];
  let completed = 0;

  const worker = async () => {
    const page = await context.newPage();
    try {
      while (true) {
        const item = queue.shift();
        if (!item) break;

        const paper = await fetchDetail(page, item);
        completed++;
        if (paper) {
          papers.push(paper);
          console.log(`    ✓ [${completed}/${items.length}] ${paper.title.substring(0, 40)}...`);
        } else {
          console.log(`    ✗ [${completed}/${items.length}] 수집 실패: ${item.text.substring(0, 40)}`);
        }
        await page.waitForTimeout(300);
      }
    } finally {
      await page.close().catch(() => {});
    }
  };

  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, items.length) }, worker));
  return papers;
}

async function fetchDetail(page, item) {
  try {
    await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
      return page.goto(item.href);
    });
    await page.waitForTimeout(2500);

    try {
      await page.evaluate(() => {
        const mv = Array.from(document.querySelectorAll('.moreView')).find(el =>
          el.parentElement?.textContent?.includes('국문 초록')
        );
        mv?.click();
      });
      await page.waitForTimeout(1500);
    } catch {}

    const txt = await page.evaluate(() => document.body.innerText);

    const titleMatch = txt.match(/(?:학술논문|학위논문|연구보고서|단행본) 상세\s*\n+([^\n]{10,})/);
    const title = titleMatch
      ? titleMatch[1].trim().split('\n')[0].replace(/\s*=\s*.*$/, '').trim()
      : item.text.split(':')[0].trim();

    const authorMatch = txt.match(/(?:저자|연구자)\s*\n+([\s\S]+?)\n\n/);
    let authorList = [];
    if (authorMatch) {
      const rawBlock = authorMatch[1];
      authorList = rawBlock.split(/[;\n]/)
        .map(line => extractKoreanName(line.replace(/\xa0/g, ' ')))
        .filter(n => n.length >= 2 && /[가-힣]/.test(n));
    }
    if (authorList.length === 0) {
      const fallback = txt.match(/저자\s*\n+([가-힣]+)/);
      if (fallback) authorList = [fallback[1]];
    }

    const firstAuthor = authorList[0] || '저자미상';
    const authorDisplay = authorList.length > 1 ? `${firstAuthor} 외` : firstAuthor;

    const yearMatch = txt.match(/발행연도\s*\n+(\d{4})/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();

    const abstractMatch = txt.match(/국문 초록 \(Abstract\)\s*\n+([\s\S]+?)(?:\n\n다국어|\n영문 초록|\n\nAbstract)/);
    const abstract2 = txt.match(/초록\s*\n+([\s\S]{30,2000}?)(?:\n\n|\n다국어|\n영문 초록)/);
    // 다국어 초록(영문만 있는 논문) 폴백
    const abstract3 = txt.match(/다국어 초록[^\n]*\n+([\s\S]{30,2000}?)(?:\n\n더보기|\n\n참고문헌|\n참고문헌|\n\n$)/);
    const rawAbstract = abstractMatch ? abstractMatch[1] : (abstract2 ? abstract2[1] : (abstract3 ? abstract3[1] : ''));
    const abstractText = rawAbstract.trim().replace(/\n더보기$/, '').trim();

    const journalMatch = txt.match(/학술지명\s*\n+([^\n]+)/);
    const journal = journalMatch ? journalMatch[1].trim() : '';

    const volNoMatch = txt.match(/권호사항\s*\n+Vol\.?(\d+)\s+No\.?(\d+)/i);
    const volume = volNoMatch ? volNoMatch[1] : '';
    const issue = volNoMatch ? volNoMatch[2] : '';

    const pagesMatch = txt.match(/수록면\s*\n+([\d\-~]+)/);
    const pages = pagesMatch ? pagesMatch[1] : '';

    const citMatch = txt.match(/KCI 피인용횟수\s*\n*(\d+)/);
    const viewMatch = txt.match(/상세조회\s*\n*(\d+)/);
    const dlMatch = txt.match(/다운로드\s*\n*(\d+)/);
    const kciCitations = citMatch ? parseInt(citMatch[1]) : 0;
    const viewCount = viewMatch ? parseInt(viewMatch[1]) : 0;
    const downloadCount = dlMatch ? parseInt(dlMatch[1]) : 0;

    const downloadInfo = await page.$eval(
      'a[onclick*="memberUrlDownload"], button[onclick*="memberUrlDownload"]',
      el => ({ onclick: el.getAttribute('onclick'), providerName: el.textContent?.trim() || '' })
    ).catch(() => null);
    const downloadOnclick = downloadInfo?.onclick || null;
    const providerName = downloadInfo?.providerName || '';

    const controlNo = item.href.match(/control_no=([^&]+)/)?.[1] || '';
    const pMatType = item.href.match(/p_mat_type=([^&]+)/)?.[1] || '';
    const filename = buildFilename({ authorDisplay, year, title, journal, volume, issue, pages });

    return {
      title, authors: authorList, authorDisplay, year, journal, volume, issue, pages,
      abstract: abstractText, kciCitations, viewCount, downloadCount,
      detailUrl: page.url(), controlNo, pMatType,
      downloadOnclick, providerName, sourceKeyword: '',
      filename, filePath: null, classified: false,
    };
  } catch (err) {
    console.error(`    ✗ 상세 정보 수집 실패: ${err.message}`);
    return null;
  }
}

function deduplicatePapers(papers) {
  const byKey = new Map();
  for (const paper of papers) {
    const key = `${paper.title.substring(0, 30)}_${paper.year}`;
    if (!byKey.has(key)) {
      byKey.set(key, paper);
    } else {
      const existing = byKey.get(key);
      if (getProviderPriority(paper.providerName) < getProviderPriority(existing.providerName)) {
        console.log(`    (중복 교체) ${paper.providerName || '기타'} > ${existing.providerName || '기타'}: ${paper.title.substring(0, 30)}`);
        byKey.set(key, paper);
      }
    }
  }
  return [...byKey.values()];
}

async function searchRiss(context, rissPage, keyword, maxPages, filters, pageOffset, totalPages) {
  // Phase A: 목록 링크 수집
  const items = await collectListItems(rissPage, keyword, maxPages, filters, pageOffset, totalPages);
  if (items.length === 0) return [];

  // Phase B: 병렬 상세 수집
  console.log(`\n  상세 정보 병렬 수집 중... (${items.length}개, ${Math.min(DETAIL_CONCURRENCY, items.length)} workers)`);
  const rawPapers = await fetchDetailsParallel(context, items);

  // Post-processing: 중복 제거
  const papers = deduplicatePapers(rawPapers);
  console.log(`  수집 완료: ${rawPapers.length}건 → 중복 제거 후 ${papers.length}건`);

  return papers;
}

async function runSearch(context, rissPage, keyword, maxPages, outputDir, filters, pageOffset, totalPages) {
  const papers = await searchRiss(context, rissPage, keyword, maxPages, filters, pageOffset, totalPages);
  const outputPath = path.join(outputDir, 'metadata.json');
  fs.writeFileSync(outputPath, JSON.stringify(papers, null, 2), 'utf8');
  console.log(`\n총 ${papers.length}개 논문 메타데이터 저장: ${outputPath}`);
  return papers;
}

module.exports = { runSearch, searchRiss, fetchDetail };
