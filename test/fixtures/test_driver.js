(function () {
  const logEl = document.getElementById('logOutput');
  function log(...args) {
    console.log('[OmniPost TestDriver]', ...args);
    if (logEl) {
      logEl.textContent += '\n' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
    }
  }

  document.getElementById('btnCheckAuth')?.addEventListener('click', () => {
    log('正在向 Service Worker 发送 CHECK_ALL_LOGIN...');
    chrome.runtime.sendMessage({ type: 'CHECK_ALL_LOGIN' }, (res) => {
      log('登录状态检查返回:', res);
    });
  });

  document.getElementById('btnTestDraft')?.addEventListener('click', () => {
    log('正在测试草稿生成流水线...');
    chrome.runtime.sendMessage({
      type: 'START_DRAFT_PIPELINE',
      payload: {
        article: {
          title: 'OmniPost 诊断测试',
          body: '这是一条通过 OmniPost Test Driver 生成的测试草稿。'
        },
        platformIds: ['weibo', 'twitter']
      }
    }, (res) => {
      log('草稿流水线返回:', res);
    });
  });

  document.getElementById('btnClearLog')?.addEventListener('click', () => {
    if (logEl) logEl.textContent = '// 日志已清空';
  });

  log('OmniPost Test Driver 已成功挂载，环境正常！');
})();
