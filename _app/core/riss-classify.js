const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function classifyPaper(paper, keyword) {
  const prompt = `다음 논문을 분석하여 주요 주제 태그를 추출하세요.

검색 키워드: "${keyword}"
제목: ${paper.title}
저자: ${paper.authors?.join(', ') || ''}
연도: ${paper.year}
초록: ${paper.abstract || '(초록 없음)'}

위 논문의 주요 주제를 3~5개의 한국어 태그로 분류하세요.
태그는 연구 주제, 연구 방법, 연구 대상을 반영해야 합니다.

JSON 형식으로만 응답하세요:
{"tags": ["태그1", "태그2", "태그3"], "primaryTag": "가장 핵심 태그 1개", "summary": "한 줄 요약 (30자 이내)"}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('JSON 파싱 실패: ' + text);
  return JSON.parse(jsonMatch[0]);
}

async function runClassify(metadataPath, pdfsDir, outputDir, keyword) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY 환경변수가 없습니다.');
    process.exit(1);
  }

  const papers = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const classifiedDir = path.join(pdfsDir, 'classified');
  const unclassifiedDir = path.join(pdfsDir, 'unclassified');

  console.log(`\n주제 분류 시작 (${papers.length}개)`);
  const results = [];

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    console.log(`  [${i + 1}/${papers.length}] ${paper.title.substring(0, 40)}...`);

    try {
      const classification = await classifyPaper(paper, keyword);
      paper.tags = classification.tags;
      paper.primaryTag = classification.primaryTag;
      paper.summary = classification.summary;
      paper.classified = true;

      // 폴더 이동
      if (paper.filePath) {
        const srcPath = path.join(outputDir, paper.filePath);
        if (fs.existsSync(srcPath)) {
          const tagDir = path.join(classifiedDir, sanitizeFolderName(classification.primaryTag));
          fs.mkdirSync(tagDir, { recursive: true });
          const destPath = path.join(tagDir, path.basename(srcPath));
          fs.renameSync(srcPath, destPath);
          paper.filePath = path.join('pdfs', 'classified', sanitizeFolderName(classification.primaryTag), path.basename(srcPath));
          console.log(`    ✓ [${classification.primaryTag}] ${classification.summary}`);
        }
      } else {
        console.log(`    ✓ (원문없음) [${classification.primaryTag}] ${classification.summary}`);
      }

      results.push(paper);
    } catch (err) {
      console.error(`    ✗ 분류 실패: ${err.message}`);
      paper.tags = [];
      paper.primaryTag = '미분류';
      paper.classified = false;
      results.push(paper);
    }

    // API rate limit 방지
    await new Promise(r => setTimeout(r, 300));
  }

  // metadata.json 업데이트
  fs.writeFileSync(metadataPath, JSON.stringify(results, null, 2), 'utf8');

  // report.csv 생성
  const csvPath = path.join(outputDir, 'report.csv');
  const csvLines = [
    '제목,저자,연도,주제태그,핵심태그,요약,파일경로,다운로드상태',
    ...results.map(p => [
      `"${(p.title || '').replace(/"/g, '""')}"`,
      `"${(p.authors || []).join('; ')}"`,
      p.year || '',
      `"${(p.tags || []).join(', ')}"`,
      `"${p.primaryTag || ''}"`,
      `"${(p.summary || '').replace(/"/g, '""')}"`,
      `"${p.filePath || ''}"`,
      p.downloadStatus || 'unknown'
    ].join(','))
  ];
  fs.writeFileSync(csvPath, '﻿' + csvLines.join('\n'), 'utf8'); // BOM for Excel
  console.log(`\nreport.csv 저장: ${csvPath}`);

  // 태그별 통계
  const tagCounts = {};
  results.forEach(p => (p.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\n주요 태그 통계:');
  topTags.forEach(([tag, count]) => console.log(`  ${tag}: ${count}건`));

  return results;
}

function sanitizeFolderName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '').trim() || '미분류';
}

module.exports = { runClassify, classifyPaper };
