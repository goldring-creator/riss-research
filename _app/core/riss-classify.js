const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── 1차: 전체 논문 목록 → 공통 카테고리 3~5개 생성 ──────
function buildCategoryPrompt(papers, keyword) {
  const list = papers.map((p, i) =>
    `[${i + 1}] ${p.title} (${p.year})`
  ).join('\n');

  return `연구 주제 키워드: "${keyword}"

다음 논문 ${papers.length}편을 보고, 이 논문들을 묶을 수 있는 주제 카테고리 3~5개를 만드세요.
카테고리는 논문들의 실제 내용을 반영하여 서로 겹치지 않아야 합니다.
카테고리 이름은 10자 이내 한국어로 작성하세요.

논문 목록:
${list}

JSON 형식으로만 응답하세요:
{"categories": ["카테고리1", "카테고리2", "카테고리3"]}`;
}

// ── 2차: 개별 논문 → 카테고리 배분 ──────────────────────
function buildAssignPrompt(paper, categories) {
  const catList = categories.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const abstract = paper.abstract ? paper.abstract.slice(0, 300) : '없음';

  return `제목: ${paper.title}
초록: ${abstract}

위 논문을 다음 카테고리 중 하나에 배정하고, 한 줄 요약도 작성하세요.

카테고리:
${catList}

JSON 형식으로만 응답하세요:
{"category": "정확한 카테고리 이름", "summary": "한 줄 요약 (30자 이내)"}`;
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]+\}/);
  if (!m) throw new Error('JSON 파싱 실패: ' + text.substring(0, 100));
  return JSON.parse(m[0]);
}

async function callApi(prompt) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

function callCli(prompt) {
  const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
  const r = spawnSync(claudePath, ['-p', prompt], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
    },
  });
  if (r.error) throw new Error(`claude CLI 실패: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`claude CLI 오류: ${r.stderr}`);
  return r.stdout.trim();
}

async function callClaude(prompt) {
  if (process.env.USE_CLAUDE_CLI === '1') return callCli(prompt);
  return callApi(prompt);
}

async function runClassify(metadataPath, pdfsDir, outputDir, keyword) {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasClaudeCli = process.env.USE_CLAUDE_CLI === '1';

  if (!hasApiKey && !hasClaudeCli) {
    console.error('분류 불가: ANTHROPIC_API_KEY 또는 Claude CLI가 필요합니다.');
    process.exit(1);
  }

  const papers = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const classifiedDir = path.join(pdfsDir, 'classified');

  // ── 1차: 공통 카테고리 결정 ─────────────────────────────
  console.log(`\n카테고리 생성 중... (${papers.length}편 분석)`);
  let categories = ['기타'];
  try {
    const catText = await callClaude(buildCategoryPrompt(papers, keyword));
    const parsed = parseJson(catText);
    if (parsed.categories && parsed.categories.length > 0) {
      categories = parsed.categories;
      console.log(`  카테고리 ${categories.length}개 생성: ${categories.join(' / ')}`);
    }
  } catch (e) {
    console.error(`  카테고리 생성 실패 (기본값 사용): ${e.message}`);
  }

  // 카테고리 폴더 미리 생성
  categories.forEach(cat => {
    fs.mkdirSync(path.join(classifiedDir, sanitizeFolderName(cat)), { recursive: true });
  });
  fs.mkdirSync(path.join(classifiedDir, '기타'), { recursive: true });

  // ── 2차: 논문별 카테고리 배정 ───────────────────────────
  console.log(`\n주제 분류 시작 (${papers.length}개)`);
  const results = [];

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    console.log(`  [${i + 1}/${papers.length}] ${paper.title.substring(0, 40)}...`);

    let assignedCategory = '기타';
    let summary = '';

    try {
      const text = await callClaude(buildAssignPrompt(paper, categories));
      const parsed = parseJson(text);
      summary = parsed.summary || '';

      // 응답 카테고리가 실제 목록에 있는지 확인 (fuzzy match)
      const match = categories.find(c =>
        c === parsed.category ||
        c.includes(parsed.category) ||
        parsed.category?.includes(c)
      );
      assignedCategory = match || '기타';

      console.log(`    → [${assignedCategory}] ${summary}`);
    } catch (e) {
      console.error(`    ✗ 배정 실패: ${e.message}`);
    }

    paper.primaryTag = assignedCategory;
    paper.summary = summary;
    paper.classified = assignedCategory !== '기타';

    // PDF 이동
    if (paper.filePath) {
      const srcPath = path.join(outputDir, paper.filePath);
      if (fs.existsSync(srcPath)) {
        const catDir = path.join(classifiedDir, sanitizeFolderName(assignedCategory));
        fs.mkdirSync(catDir, { recursive: true });
        const destPath = path.join(catDir, path.basename(srcPath));
        try {
          fs.renameSync(srcPath, destPath);
          paper.filePath = path.join(
            'pdfs', 'classified',
            sanitizeFolderName(assignedCategory),
            path.basename(srcPath)
          );
        } catch {}
      }
    }

    results.push(paper);

    if (hasApiKey) await new Promise(r => setTimeout(r, 300));
  }

  fs.writeFileSync(metadataPath, JSON.stringify(results, null, 2), 'utf8');

  // ── 카테고리별 통계 출력 ────────────────────────────────
  const catCounts = {};
  results.forEach(p => {
    const c = p.primaryTag || '기타';
    catCounts[c] = (catCounts[c] || 0) + 1;
  });
  console.log('\n카테고리별 분류 결과:');
  Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, n]) => console.log(`  ${cat}: ${n}건`));

  // ── CSV 저장 ─────────────────────────────────────────────
  const csvPath = path.join(outputDir, 'report.csv');
  const csvLines = [
    '제목,저자,연도,카테고리,요약,파일경로,다운로드상태',
    ...results.map(p => [
      `"${(p.title || '').replace(/"/g, '""')}"`,
      `"${(p.authors || []).join('; ')}"`,
      p.year || '',
      `"${p.primaryTag || ''}"`,
      `"${(p.summary || '').replace(/"/g, '""')}"`,
      `"${p.filePath || ''}"`,
      p.downloadStatus || 'unknown',
    ].join(',')),
  ];
  fs.writeFileSync(csvPath, '﻿' + csvLines.join('\n'), 'utf8');
  console.log(`\nreport.csv 저장: ${csvPath}`);

  return results;
}

function sanitizeFolderName(name) {
  return (name || '기타').replace(/[\\/:*?"<>|]/g, '').trim() || '기타';
}

module.exports = { runClassify };
