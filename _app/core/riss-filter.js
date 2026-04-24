const { spawnSync } = require('child_process');

const BATCH_SIZE = 15;

function buildPrompt(papers, keywords, researchContext) {
  const list = papers.map((p, i) => {
    const abstract = p.abstract ? p.abstract.replace(/\s+/g, ' ').trim().slice(0, 700) : '없음';
    return `[${i + 1}] 제목: ${p.title}\n초록: ${abstract}`;
  }).join('\n\n');

  const contextLine = researchContext
    ? `연구 맥락:\n${researchContext}\n\n검색 키워드: ${keywords.join(', ')}`
    : `연구 키워드: ${keywords.join(', ')}`;

  return `${contextLine}

아래 논문 목록에서 위 연구의 선행연구·이론적 배경으로 활용 가능한 논문의 번호만 쉼표로 나열하세요.
관련 없는 논문은 제외하세요. 숫자와 쉼표만 출력하세요.

${list}`;
}

function parseIndices(text, batchLen) {
  const nums = text.match(/\d+/g);
  if (!nums) return [];
  return nums
    .map(n => parseInt(n) - 1)
    .filter(i => i >= 0 && i < batchLen);
}

async function assessBatch(papers, keywords, opts) {
  const prompt = buildPrompt(papers, keywords, opts.researchContext);

  let responseText = '';

  if (opts.anthropicKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: opts.anthropicKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    responseText = msg.content[0].text;
  } else if (opts.useClaudeCli && opts.claudeCliPath) {
    const r = spawnSync(opts.claudeCliPath, ['-p', prompt], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH}`,
      },
    });
    if (r.error) throw new Error(`Claude CLI 오류: ${r.error.message}`);
    responseText = r.stdout || '';
  } else {
    // AI 없음 → 전체 통과
    return papers;
  }

  const indices = parseIndices(responseText, papers.length);
  if (indices.length === 0) {
    // 파싱 실패 시 전체 통과 (안전 장치)
    console.log('    (관련도 파싱 실패 — 전체 통과)');
    return papers;
  }
  return papers.filter((_, i) => indices.includes(i));
}

async function filterByRelevance(papers, keywords, opts, onLog) {
  const log = onLog || console.log;
  const total = papers.length;
  const relevant = [];
  let processed = 0;

  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    const batch = papers.slice(i, i + BATCH_SIZE);
    processed += batch.length;
    log(`  관련도 평가 중... [${processed}/${total}]`);

    try {
      const kept = await assessBatch(batch, keywords, opts);
      relevant.push(...kept);
      log(`  배치 결과: ${batch.length}건 중 ${kept.length}건 유지\n`);
    } catch (e) {
      log(`  배치 평가 오류 (전체 통과): ${e.message}\n`);
      relevant.push(...batch);
    }
  }

  return relevant;
}

module.exports = { filterByRelevance };
