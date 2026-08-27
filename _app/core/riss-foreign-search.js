// RISS 해외전자정보서비스 논문 검색 모듈
// 엔드포인트: /fsearch/Fsearch.do?colName=re_e_over
const fs = require('fs');
const path = require('path');

function buildForeignFilename({ authorDisplay, year, title, journal, volume, issue, pages }) {
  const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '').trim();
  let name = `${authorDisplay}(${year}). ${cleanTitle}`;
  if (journal) {
    name += `. ${journal.replace(/[\\/:*?"<>|]/g, '').trim()}`;
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

function buildAuthorDisplay(authorsRaw) {
  if (!authorsRaw) return 'Unknown';
  const parts = authorsRaw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return 'Unknown';
  const first = parts[0].split(',')[0].trim();
  return parts.length > 1 ? `${first} et al.` : first;
}

// 해외전자정보서비스(EDS) 검색 URL 생성
// 중요: 가시 검색필드 `query`가 반드시 있어야 결과가 나온다.
//       공백은 '+' 인코딩(폼 GET 방식), '%20'이면 0건 반환됨.
//       페이지는 iStartCount(0,10,20…) + pageScale=10 로 이동.
function buildForeignSearchUrl(rissBase, keyword, filters, iStartCount) {
  const q = encodeURIComponent(keyword).replace(/%20/g, '+');
  let url = `${rissBase}/fsearch/Fsearch.do?colName=re_e_over` +
    `&isDetailSearch=N&searchGubun=true&sflag=1&fsearchMethod=search&isFDetailSearch=N&viewYn=OP` +
    `&query=${q}&queryText=${q}&strQuery=${q}` +
    `&pageScale=10&isTab=Y&iStartCount=${iStartCount}`;
  if (filters.yearFrom) url += `&p_year1=${filters.yearFrom}`;
  if (filters.yearTo) url += `&p_year2=${filters.yearTo}`;
  return url;
}

// 검색 결과 목록 수집
async function collectForeignListItems(rissPage, keyword, maxPages, filters, pageOffset, totalPages) {
  console.log(`\n해외 논문 검색: "${keyword}" (최대 ${maxPages}페이지)`);

  const rissBase = (() => {
    try {
      const u = new URL(rissPage.url());
      return `${u.protocol}//${u.host}`;
    } catch { return 'https://www.riss.kr'; }
  })();

  const allRaw = [];
  const seenKeys = new Set();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const globalPage = pageOffset + pageNum;
    console.log(`  페이지 [${globalPage}/${totalPages}] 수집 중...`);

    const iStartCount = (pageNum - 1) * 10;
    const searchUrl = buildForeignSearchUrl(rissBase, keyword, filters, iStartCount);
    if (process.env.RISS_DEBUG) console.log(`    [DEBUG] GOTO ${searchUrl}`);
    await rissPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() =>
      rissPage.goto(searchUrl).catch(() => {})
    );
    // 결과 목록 렌더링을 기다림 (cold GET은 수 초 지연될 수 있음)
    let titleCount = await rissPage.waitForSelector('p.title a[href*="DetailView.do"]', { timeout: 15000 })
      .then(() => rissPage.$$eval('p.title a[href*="DetailView.do"]', els => els.length))
      .catch(() => 0);

    // 여전히 0건이면(스로틀/검색 미실행) 검색창 직접 제출로 재시도
    if (titleCount === 0) {
      try {
        // 접힌 검색창 펼치기 시도 후 입력
        const box = await rissPage.waitForSelector('#edsText, input[name="query"]', { state: 'visible', timeout: 4000 }).catch(() => null);
        if (box) {
          await box.fill(keyword);
          await rissPage.click('.btnSearch, button.btnSearch').catch(() => {});
          titleCount = await rissPage.waitForSelector('p.title a[href*="DetailView.do"]', { timeout: 15000 })
            .then(() => rissPage.$$eval('p.title a[href*="DetailView.do"]', els => els.length))
            .catch(() => 0);
          if (process.env.RISS_DEBUG) console.log(`    [DEBUG] UI 제출 재시도 → titleLinks=${titleCount}`);
        }
      } catch (e) {
        if (process.env.RISS_DEBUG) console.log(`    [DEBUG] UI 제출 실패: ${e.message}`);
      }
    }

    // 1페이지에서만 총 건수 로그
    if (pageNum === 1) {
      const diag = await rissPage.evaluate(() => ({
        count: (document.body.innerText.match(/검색결과\s*[\d,]+\s*건/) || [''])[0],
        landed: location.href,
        titleLinks: document.querySelectorAll('p.title a[href*="DetailView.do"]').length,
        noResult: /검색결과가 없습니다/.test(document.body.innerText),
        snippet: document.body.innerText.replace(/\s+/g, ' ').substring(0, 200),
      }));
      if (diag.count) console.log(`    ${diag.count}`);
      if (process.env.RISS_DEBUG) {
        console.log(`    [DEBUG] landed=${diag.landed}`);
        console.log(`    [DEBUG] titleLinks=${diag.titleLinks} noResult=${diag.noResult}`);
        console.log(`    [DEBUG] snippet=${diag.snippet}`);
      }
    }

    const items = await rissPage.evaluate(() => {
      const results = [];
      // 결과 아이템: p.title > a[href*="DetailView.do"] 를 가진 li
      const titleLinks = Array.from(document.querySelectorAll('p.title a[href*="DetailView.do"]'));

      titleLinks.forEach(titleEl => {
        const item = titleEl.closest('li');
        if (!item) return;

        const title = titleEl.textContent?.trim().replace(/\s+/g, ' ');
        if (!title || title.length < 5) return;

        const detailHref = titleEl.getAttribute('href') || '';
        // icate: Academic Journals / EBooks / Dissertations 구분
        const icate = decodeURIComponent((detailHref.match(/icate=([^&]*)/) || [])[1] || '');
        const isBook = !!item.querySelector('div.bookcoverW');

        // 저자
        const authorsRaw = item.querySelector('span.writer')?.textContent?.trim().replace(/\s+/g, ' ') || '';
        // 저널·서지 정보
        const journalRaw = item.querySelector('p.etc')?.textContent?.trim().replace(/\s+/g, ' ') || '';
        const yearMatch = journalRaw.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : '';

        // 원문보기(Fulltext) 링크
        const oriEl = item.querySelector('li.viewOri a, .viewOri a');
        const fullTextUrl = oriEl?.href || '';
        const fullTextOnclick = oriEl?.getAttribute('onclick') || '';
        const hasFulltext = !!oriEl && !/disabled|none/i.test(oriEl.className || '');

        // DOI
        const doiEl = item.querySelector('a[href*="doi.org"]');
        const doi = doiEl?.href?.replace(/.*doi\.org\//, '') || '';

        // SCOPUS/SSCI 등 배지 (p.type)
        const badges = Array.from(item.querySelectorAll('p.type'))
          .map(b => b.textContent?.trim()).filter(Boolean);

        results.push({
          title, authorsRaw, journalRaw, year, fullTextUrl, fullTextOnclick,
          hasFulltext, doi, badges, icate, isBook,
          detailUrl: titleEl.href || '',
        });
      });
      return results;
    });

    // Academic Journals만 (EBooks/Dissertations 제외)
    const journalItems = items.filter(p =>
      !p.isBook && (!p.icate || /Academic Journals|Journal/i.test(p.icate))
    );

    if (journalItems.length === 0 && items.length === 0) {
      console.log(`    수집 0건 — 다음 페이지 없음(종료)`);
      break;
    }

    const unique = journalItems.filter(p => {
      const k = p.doi || p.title.substring(0, 60);
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });
    console.log(`    ${unique.length}개 논문 수집 (전체 ${items.length}건 중 학술논문)`);
    allRaw.push(...unique);
  }

  return allRaw;
}

// 상세 페이지에서 초록·원문 링크 보완
async function enrichDetail(context, rawPaper) {
  if (!rawPaper.detailUrl) return rawPaper;
  const page = await context.newPage();
  try {
    await page.goto(rawPaper.detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const detail = await page.evaluate(() => {
      // 해외전자정보 상세페이지: .infoDetail 에 서지정보가 라벨 형태로 들어있음
      //  예) "Authors ... Source <저널>, <연도> <월>. <권>(<호>), <시작>-<끝>. Language English
      //       ISSN ... Document Type ... Publication Year 2026 Access URL https://... Database ..."
      const infoText = (document.querySelector('.infoDetail, .detailInfo, .contentDetail')?.textContent || document.body.innerText)
        .replace(/\s+/g, ' ').trim();

      const field = (label, next) => {
        const re = new RegExp(label + '\\s*(.+?)\\s*(?:' + next + ')', 'i');
        const m = infoText.match(re);
        return m ? m[1].trim() : '';
      };

      // Source: 다음 라벨(Language/ISSN/Document Type/Publication) 전까지
      const source = field('Source', 'Language|ISSN|Document Type|Publication Year|Access URL|Database|$');
      // Source에서 연도/권(호)/페이지 파싱
      const year = (infoText.match(/Publication Year\s*(\d{4})/i) || source.match(/\b(19|20)\d{2}\b/) || [])[1]
        || (source.match(/\b((?:19|20)\d{2})\b/) || [])[1] || '';
      const volIssue = source.match(/(\d+)\s*\(([^)]+)\)/);
      const volume = volIssue ? volIssue[1] : '';
      const issue = volIssue ? volIssue[2] : '';
      const pagesM = source.match(/(\d+\s*[-–]\s*\d+)\s*\.?\s*$/) || source.match(/,\s*(\d+\s*[-–]\s*\d+)/);
      const pages = pagesM ? pagesM[1].replace(/\s/g, '') : '';
      // 저널명: Source 앞부분 (연도/콤마 전까지)
      let journal = source.replace(/,\s*(?:19|20)\d{2}.*$/, '').trim();
      if (!journal) journal = source.split(',')[0].trim();

      const issn = field('ISSN', 'Document Type|Publication Year|Access URL|Database|Language|$');
      const docType = field('Document Type', 'Publication Year|Access URL|Database|ISSN|Language|$');
      // Access URL: 출판사 원문 링크 (JSTOR/Wiley/ScienceDirect 등)
      const accessUrl = (infoText.match(/Access URL\s*(https?:\/\/\S+)/i) || [])[1] || '';

      // DOI (있으면)
      const doi = (infoText.match(/DOI[:\s]+(10\.\d{4,}\/\S+)/i) || [])[1]
        || (accessUrl.match(/doi\.org\/(10\.\S+)/) || [])[1] || '';

      // 초록: Abstract/Description 뒤 본문 (언어 선택 UI 텍스트는 제외)
      let abstract = '';
      const abEl = document.querySelector('.abstractTextView, .txtAbstract, .abstract p, #divAbstract');
      if (abEl) abstract = abEl.textContent.trim().replace(/\s+/g, ' ');
      if (!abstract) {
        const m = infoText.match(/Abstract\s+([A-Z][^]{40,1200}?)(?:\s+(?:Keywords|Subjects|Database|서지정보))/i);
        if (m) abstract = m[1].trim();
      }

      return { journal, year, volume, issue, pages, issn, docType, accessUrl, doi, abstract };
    });

    return {
      ...rawPaper,
      journal: detail.journal || rawPaper.journal || '',
      year: detail.year || rawPaper.year || '',
      volume: detail.volume || rawPaper.volume || '',
      issue: detail.issue || rawPaper.issue || '',
      pages: detail.pages || rawPaper.pages || '',
      issn: detail.issn || '',
      docType: detail.docType || '',
      accessUrl: detail.accessUrl || '',
      fullTextUrl: detail.accessUrl || rawPaper.fullTextUrl || '',
      doi: detail.doi || rawPaper.doi || '',
      abstract: detail.abstract || rawPaper.abstract || '',
    };
  } catch {
    return rawPaper;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runForeignSearch(context, rissPage, keyword, maxPages, outputDir, filters, pageOffset, totalPages) {
  const rawPapers = await collectForeignListItems(rissPage, keyword, maxPages, filters, pageOffset, totalPages);

  console.log(`\n  상세 정보 보완 중... (${rawPapers.length}건, 3 workers)`);
  const CONCURRENCY = 3;
  const queue = [...rawPapers];
  const enriched = [];
  let done = 0;

  const worker = async () => {
    while (true) {
      const paper = queue.shift();
      if (!paper) break;
      const result = await enrichDetail(context, paper);
      done++;
      console.log(`    ✓ [${done}/${rawPapers.length}] ${result.title.substring(0, 45)}...`);
      enriched.push(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rawPapers.length || 1) }, worker));

  const papers = enriched.map(p => {
    const authorDisplay = buildAuthorDisplay(p.authorsRaw);
    const authors = p.authorsRaw
      ? p.authorsRaw.split(/[;,]/).map(s => s.trim()).filter(Boolean)
      : [];

    // enrichDetail(.infoDetail 파싱)에서 온 값 우선, 없으면 목록 텍스트로 보완
    const journal = p.journal || (p.journalRaw.match(/^([^,|]+)/) || [,''])[1].trim();
    const year = p.year || '';
    const volume = p.volume || '';
    const issue = p.issue || '';

    const filename = buildForeignFilename({
      authorDisplay, year, title: p.title,
      journal, volume, issue, pages: p.pages,
    });

    return {
      title: p.title,
      authors,
      authorDisplay,
      year,
      journal,
      volume,
      issue,
      pages: p.pages || '',
      issn: p.issn || '',
      docType: p.docType || '',
      abstract: p.abstract || '',
      doi: p.doi || '',
      accessUrl: p.accessUrl || '',
      fullTextUrl: p.fullTextUrl || '',
      detailUrl: p.detailUrl || '',
      badges: p.badges || [],
      isScopus: (p.badges || []).some(b => /scopus/i.test(b)),
      isSsci: (p.badges || []).some(b => /ssci/i.test(b)),
      filename,
      filePath: null,
      downloadStatus: 'pending',
      sourceKeyword: keyword,
      source: 'riss_overseas',
    };
  });

  const outputPath = path.join(outputDir, 'metadata.json');
  const existing = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : [];
  // DOI 기반 중복 제거 후 병합
  const existingDois = new Set(existing.map(p => p.doi).filter(Boolean));
  const newPapers = papers.filter(p => !p.doi || !existingDois.has(p.doi));
  const merged = [...existing, ...newPapers];
  fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\n총 ${papers.length}개 해외 논문 수집 (신규 ${newPapers.length}건 추가)`);
  return papers;
}

module.exports = { runForeignSearch };
