const fs = require('fs');
const path = require('path');

// 제공사 다운로드 우선순위 (낮을수록 높은 우선순위)
const PROVIDER_PRIORITY = {
  'kci': 1,
  'kci.go.kr': 1,
  '스콜라': 2,
  'scholar': 2,
  'kyobo': 2,
  'kiss': 3,
  'dbpia': 4,
  'earticle': 5,
  '원문보기': 6,
  'default': 7,
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

async function searchRiss(rissPage, keyword, maxPages = 3, filters = {}) {
  const { yearFrom, yearTo, kciOnly, sortBy } = filters;
  console.log(`\n검색 키워드: "${keyword}" (최대 ${maxPages}페이지)`);

  // 국내학술논문(re_a_kor)만 검색 — 해외논문/학위논문 제외
  let searchUrl = `https://www.riss.kr/search/Search.do?isDetailSearch=N&searchGubun=true&viewYn=OP&query=${encodeURIComponent(keyword)}&colName=re_a_kor&p_mat_type=1a0202e37d52c72d`;

  if (yearFrom) searchUrl += `&p_year1=${yearFrom}`;
  if (yearTo) searchUrl += `&p_year2=${yearTo}`;
  if (kciOnly) searchUrl += `&regnm=KCI%EB%93%B1%EC%9E%AC`;

  // strSort: RANK(정확도), DATE(연도), VIEWCOUNT(인기도) + order=/DESC|/ASC
  const sortMap = { newest: 'DATE', rank: 'RANK', popular: 'VIEWCOUNT' };
  const strSort = sortMap[sortBy] || 'RANK';
  searchUrl += `&strSort=${strSort}&order=/DESC`;

  await rissPage.goto(searchUrl);
  await rissPage.waitForTimeout(5000);

  const papers = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    console.log(`  페이지 ${pageNum} 수집 중...`);

    // 결과 링크 수집 (제목 링크만, 저널/권호 링크 제외)
    const items = await rissPage.$$eval('a[href*="DetailView"]', els =>
      els
        .filter(e => e.textContent?.trim().length > 10)
        .map(e => ({ text: e.textContent.trim(), href: e.href }))
    );

    // 중복 제거 + 잡링크 필터 (Vol.X No.X 같은 저널 권호 링크 제외)
    const seen = new Set();
    const uniqueItems = items.filter(item => {
      const match = item.href.match(/control_no=([^&]+)/);
      if (!match) return false;
      if (seen.has(match[1])) return false;
      if (/^Vol\.\s*\d+/.test(item.text.trim())) return false;
      seen.add(match[1]);
      return true;
    });

    console.log(`    ${uniqueItems.length}개 논문 링크 발견`);

    // 각 논문 상세 페이지 방문
    for (const item of uniqueItems) {
      const paper = await fetchDetail(rissPage, item);
      if (paper) {
        // 제목+연도 기준 중복 제거 — 제공사 우선순위가 높은 쪽 유지
        const dupKey = `${paper.title.substring(0, 30)}_${paper.year}`;
        const existingIdx = papers.findIndex(p => `${p.title.substring(0, 30)}_${p.year}` === dupKey);
        if (existingIdx >= 0) {
          const existing = papers[existingIdx];
          const newPriority = getProviderPriority(paper.providerName);
          const oldPriority = getProviderPriority(existing.providerName);
          if (newPriority < oldPriority) {
            papers[existingIdx] = paper;
            console.log(`    (중복 교체) ${paper.providerName || '기타'} > ${existing.providerName || '기타'}: ${paper.title.substring(0, 35)}...`);
          } else {
            console.log(`    (중복 유지) ${existing.providerName || '기타'} 우선: ${paper.title.substring(0, 35)}...`);
          }
        } else {
          papers.push(paper);
          console.log(`    ✓ [${papers.length}] ${paper.title.substring(0, 40)}...`);
        }
      }
      await rissPage.waitForTimeout(500);
    }

    // 다음 페이지로 이동 (URL 파라미터 방식)
    if (pageNum < maxPages) {
      const nextBtn = await rissPage.$(`a[href*="pageNumber=${pageNum + 1}"]`);
      if (nextBtn) {
        await nextBtn.click();
        await rissPage.waitForTimeout(4000);
      } else {
        console.log(`  다음 페이지(${pageNum + 1})가 없습니다.`);
        break;
      }
    }
  }

  return papers;
}

async function fetchDetail(rissPage, item) {
  try {
    await rissPage.goto(item.href);
    await rissPage.waitForTimeout(3000);

    const txt = await rissPage.evaluate(() => document.body.innerText);

    // 제목: "상세\n{제목}" 패턴
    const titleMatch = txt.match(/(?:학술논문|학위논문|연구보고서|단행본) 상세\s*\n+([^\n]{10,})/);
    const title = titleMatch
      ? titleMatch[1].trim().split('\n')[0].replace(/\s*=\s*.*$/, '').trim()
      : item.text.split(':')[0].trim();

    // 저자: 괄호 안 영문 이름을 포함한 전체 저자 블록 추출
    const authorMatch = txt.match(/(?:저자|연구자)\s*\n+([\s\S]+?)\n\n/);
    let authorList = [];
    if (authorMatch) {
      const rawBlock = authorMatch[1];
      // 세미콜론, 콤마, 줄바꿈으로 구분된 저자 목록
      authorList = rawBlock.split(/[;\n]/)
        .map(line => extractKoreanName(line.replace(/\xa0/g, ' ')))
        .filter(n => n.length >= 2 && /[가-힣]/.test(n));
    }
    if (authorList.length === 0) {
      // fallback: 발행기관 앞의 이름 패턴
      const fallback = txt.match(/저자\s*\n+([가-힣]+)/);
      if (fallback) authorList = [fallback[1]];
    }

    const firstAuthor = authorList[0] || '저자미상';
    const authorDisplay = authorList.length > 1 ? `${firstAuthor} 외` : firstAuthor;

    // 연도
    const yearMatch = txt.match(/발행연도\s*\n+(\d{4})/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();

    // 초록
    const abstractMatch = txt.match(/국문 초록 \(Abstract\)\s*\n+([\s\S]+?)(?:\n더보기|\n\n다국어)/);
    const abstract2 = txt.match(/초록\s*\n+([\s\S]{30,600}?)(?:\n\n|더보기)/);
    const abstractText = abstractMatch
      ? abstractMatch[1].trim()
      : (abstract2 ? abstract2[1].trim() : '');

    // 피인용·조회·다운로드 수
    const citMatch = txt.match(/KCI 피인용횟수\s*\n*(\d+)/);
    const viewMatch = txt.match(/상세조회\s*\n*(\d+)/);
    const dlMatch = txt.match(/다운로드\s*\n*(\d+)/);
    const kciCitations = citMatch ? parseInt(citMatch[1]) : 0;
    const viewCount = viewMatch ? parseInt(viewMatch[1]) : 0;
    const downloadCount = dlMatch ? parseInt(dlMatch[1]) : 0;

    // 원문보기 onclick + 제공사명
    const downloadInfo = await rissPage.$eval(
      'a[onclick*="memberUrlDownload"], button[onclick*="memberUrlDownload"]',
      el => ({ onclick: el.getAttribute('onclick'), providerName: el.textContent?.trim() || '' })
    ).catch(() => null);
    const downloadOnclick = downloadInfo?.onclick || null;
    const providerName = downloadInfo?.providerName || '';

    const controlNo = item.href.match(/control_no=([^&]+)/)?.[1] || '';
    const pMatType = item.href.match(/p_mat_type=([^&]+)/)?.[1] || '';

    const titleShort = title.replace(/[\\/:*?"<>|]/g, '').substring(0, 20).trim();
    const filename = `${authorDisplay}(${year}). ${titleShort}.pdf`;

    return {
      title,
      authors: authorList,
      authorDisplay,
      year,
      abstract: abstractText,
      kciCitations,
      viewCount,
      downloadCount,
      detailUrl: rissPage.url(),
      controlNo,
      pMatType,
      downloadOnclick,
      providerName,
      sourceKeyword: '',
      filename,
      filePath: null,
      classified: false
    };
  } catch (err) {
    console.error(`    ✗ 상세 정보 수집 실패: ${err.message}`);
    return null;
  }
}

async function runSearch(rissPage, keyword, maxPages, outputDir, filters = {}) {
  const papers = await searchRiss(rissPage, keyword, maxPages, filters);
  const outputPath = path.join(outputDir, 'metadata.json');
  fs.writeFileSync(outputPath, JSON.stringify(papers, null, 2), 'utf8');
  console.log(`\n총 ${papers.length}개 논문 메타데이터 저장: ${outputPath}`);
  return papers;
}

module.exports = { runSearch, searchRiss, fetchDetail };
