// 依存なしの、ごく小さなテスト実行基盤
const __tests = [];

function test(name, fn) {
  __tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'eq'}: expected ${b} but got ${a}`);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('failed to load ' + src));
    document.head.append(script);
  });
}

function finish(pass, fail, lines) {
  const summary = `${pass} passed, ${fail} failed`;
  document.getElementById('results').textContent = lines.join('\n') + '\n\n' + summary;
  document.body.dataset.summary = summary;
  document.body.dataset.failed = String(fail);
  document.title = summary;
  // tests/run.py から開いたときは、結果を送り返す（ふつうに開いたときは、送れなくても気にしない）
  fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary, failed: fail, text: document.getElementById('results').textContent }) }).catch(() => {});
}

async function runAll() {
  let pass = 0, fail = 0;
  const lines = [];
  for (const t of __tests) {
    try {
      await t.fn();
      pass++;
      lines.push('PASS  ' + t.name);
    } catch (error) {
      fail++;
      lines.push('FAIL  ' + t.name + '\n        ' + (error && error.message || error));
    }
  }
  finish(pass, fail, lines);
}
