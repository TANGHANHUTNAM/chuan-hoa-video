'use strict';

/*
 * Small progressive-enhancement helpers. Kept dependency-free and out of inline
 * script tags so the strict CSP (script-src 'self') stays intact.
 *
 * Behaviours are opted into with data- attributes:
 *   data-confirm="..."         confirm before submitting a form / following a link
 *   data-poll-url / -interval  re-fetch JSON and refresh matching [data-bind] nodes
 *   data-tabs                  simple tab group
 */

// ---------- confirm ----------

document.addEventListener('submit', (event) => {
  const message = event.target.getAttribute?.('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});

document.addEventListener('click', (event) => {
  const el = event.target.closest?.('a[data-confirm], button[data-confirm]');
  if (!el || el.matches('[type="submit"]')) return;
  if (!window.confirm(el.getAttribute('data-confirm'))) event.preventDefault();
});

// ---------- tabs ----------

function initTabs(root) {
  const buttons = Array.from(root.querySelectorAll('[role="tab"]'));
  if (!buttons.length) return;

  const select = (id) => {
    for (const btn of buttons) {
      const active = btn.getAttribute('aria-controls') === id;
      btn.setAttribute('aria-selected', String(active));
      const panel = document.getElementById(btn.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    }
    const hidden = root.querySelector('[data-tab-value]');
    if (hidden) {
      const chosen = buttons.find((b) => b.getAttribute('aria-controls') === id);
      hidden.value = (chosen && chosen.dataset.tabName) || id;
    }
  };

  root.addEventListener('click', (event) => {
    const btn = event.target.closest('[role="tab"]');
    if (btn) select(btn.getAttribute('aria-controls'));
  });

  const preselected = buttons.find((b) => b.getAttribute('aria-selected') === 'true');
  select((preselected || buttons[0]).getAttribute('aria-controls'));
}

document.querySelectorAll('[data-tabs]').forEach(initTabs);

// ---------- polling ----------

/**
 * Replaces the text of [data-bind="path.to.value"] nodes and the width of
 * [data-bind-width] nodes from a JSON payload. Elements can also declare
 * data-bind-class to swap a status class.
 */
function applyBindings(scope, payload) {
  const read = (path) =>
    path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), payload);

  scope.querySelectorAll('[data-bind]').forEach((el) => {
    const value = read(el.getAttribute('data-bind'));
    if (value !== undefined && value !== null) el.textContent = String(value);
  });

  scope.querySelectorAll('[data-bind-width]').forEach((el) => {
    const value = read(el.getAttribute('data-bind-width'));
    if (value !== undefined && value !== null) el.style.width = `${Number(value)}%`;
  });

  scope.querySelectorAll('[data-bind-class]').forEach((el) => {
    const [path, prefix] = el.getAttribute('data-bind-class').split('|');
    const value = read(path);
    if (value === undefined || value === null) return;
    el.className = el.className
      .split(' ')
      .filter((c) => c && !c.startsWith(`${prefix || 'is'}-`))
      .join(' ');
    el.classList.add(`${prefix || 'is'}-${value}`);
  });

  scope.querySelectorAll('[data-bind-html]').forEach((el) => {
    const value = read(el.getAttribute('data-bind-html'));
    if (typeof value === 'string') el.innerHTML = value;
  });
}

function startPolling(root) {
  const url = root.getAttribute('data-poll-url');
  if (!url) return;
  const interval = Number(root.getAttribute('data-poll-interval')) || 10000;
  // Poll until the endpoint reports a terminal state, then optionally reload so
  // the server-rendered page reflects the finished work.
  const stopWhen = (root.getAttribute('data-poll-stop-when') || '').split(',').filter(Boolean);
  const stopField = root.getAttribute('data-poll-stop-field') || 'status';
  const reloadOnStop = root.hasAttribute('data-poll-reload');

  let timer = null;
  let failures = 0;

  const tick = async () => {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      failures = 0;
      applyBindings(root, data);

      const state = String(data[stopField] ?? '');
      if (stopWhen.length && stopWhen.includes(state)) {
        clearInterval(timer);
        if (reloadOnStop) window.location.reload();
        return;
      }
    } catch {
      // Transient network blips are expected; back off instead of hammering.
      failures += 1;
      if (failures >= 5) clearInterval(timer);
    }
  };

  timer = setInterval(tick, interval);
  tick();
}

document.querySelectorAll('[data-poll-url]').forEach(startPolling);

// ---------- test SSH connection ----------

/**
 * Checks the credentials in the Add Server form without saving anything, so the
 * user finds out about a typo before provisioning starts.
 */
function initTestConnection(button) {
  const form = button.closest('form');
  const output = document.getElementById('test-result');
  if (!form || !output) return;

  button.addEventListener('click', async () => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Đang kiểm tra…';
    output.innerHTML = '';

    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch('/api/servers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (data.ok) {
        const lines = [
          data.message,
          data.osName ? `Hệ điều hành: ${data.osName}` : null,
          data.ffmpegInstalled ? 'FFmpeg: đã có sẵn' : 'FFmpeg: chưa có, app sẽ tự cài',
          data.fingerprint ? `Danh tính SSH: ${data.fingerprint}` : null,
        ].filter(Boolean);
        output.innerHTML =
          '<div class="alert is-ok"><strong>Kết nối được</strong>' +
          lines.map((l) => `<div class="small">${escapeHtml(l)}</div>`).join('') +
          '</div>';
      } else {
        output.innerHTML =
          '<div class="alert is-error"><strong>Không kết nối được</strong>' +
          `<div class="small">${escapeHtml(data.message || 'Lỗi không xác định.')}</div></div>`;
      }
    } catch {
      output.innerHTML =
        '<div class="alert is-error"><strong>Không gửi được yêu cầu</strong>' +
        '<div class="small">Kiểm tra lại kết nối mạng của bạn.</div></div>';
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

document.querySelectorAll('[data-test-connection]').forEach(initTestConnection);

// ---------- reload the wizard when the VPS changes ----------

document.querySelectorAll('[data-reload-on-change]').forEach((select) => {
  select.addEventListener('change', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('server', select.value);
    window.location.href = url.toString();
  });
});

// ---------- create-project wizard: video picker ----------

function alertHtml(tone, title, body) {
  return (
    `<div class="alert is-${tone}" style="margin-top:0.85rem">` +
    (title ? `<strong>${escapeHtml(title)}</strong>` : '') +
    (body ? `<div class="small" style="white-space:pre-line">${escapeHtml(body)}</div>` : '') +
    '</div>'
  );
}

function initVideoPicker(root) {
  const serverId = root.getAttribute('data-server-id');
  const videoIdField = document.getElementById('video_id');

  const setVideo = (id) => { if (videoIdField) videoIdField.value = id || ''; };

  // --- existing video radios ---
  root.querySelectorAll('[data-pick-video]').forEach((radio) => {
    radio.addEventListener('change', () => { if (radio.checked) setVideo(radio.value); });
  });

  // --- upload from computer ---
  const fileInput = root.querySelector('#upload-file');
  const startBtn = root.querySelector('[data-upload-start]');
  const cancelBtn = root.querySelector('[data-upload-cancel]');
  const progressBox = root.querySelector('[data-upload-progress]');
  const progressBar = progressBox && progressBox.querySelector('.bar > span');
  const progressLabel = root.querySelector('[data-upload-label]');
  const progressPercent = root.querySelector('[data-upload-percent]');
  const uploadResult = root.querySelector('[data-upload-result]');
  let xhr = null;

  const fmt = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i <= 1 ? 0 : 2)} ${units[i]}`;
  };

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) {
        uploadResult.innerHTML = alertHtml('warn', 'Chưa chọn file', 'Hãy chọn một file video.');
        return;
      }
      uploadResult.innerHTML = '';

      // Ask the server whether it fits BEFORE sending a single byte
      // (spec section 17B).
      try {
        const pre = await fetch('/api/videos/preflight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ server_id: serverId, size: file.size }),
        }).then((r) => r.json());

        if (!pre.allowed) {
          uploadResult.innerHTML = alertHtml('error', 'Không đủ dung lượng VPS', pre.message);
          return;
        }
      } catch {
        uploadResult.innerHTML = alertHtml('error', 'Không kiểm tra được dung lượng', 'Thử lại sau.');
        return;
      }

      const form = new FormData();
      // Fields first: the server needs them before the file part arrives.
      form.append('server_id', serverId);
      form.append('size', String(file.size));
      form.append('file', file);

      startBtn.disabled = true;
      cancelBtn.hidden = false;
      progressBox.hidden = false;

      xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/videos/upload');
      xhr.setRequestHeader('Accept', 'application/json');

      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        progressBar.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
        progressLabel.textContent = `${fmt(event.loaded)} / ${fmt(event.total)}`;
      });

      xhr.addEventListener('load', () => {
        startBtn.disabled = false;
        cancelBtn.hidden = true;
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }

        if (xhr.status === 200 && data.ok) {
          setVideo(data.videoId);
          progressLabel.textContent = 'Đã tải lên xong';
          uploadResult.innerHTML = data.compliant
            ? alertHtml('ok', 'Video đã sẵn sàng', 'Đã chọn video này cho project.')
            : alertHtml(
                'warn',
                'Video cần chuẩn hoá cho Facebook',
                (data.notes || []).join('\n') +
                  '\n\nProject vẫn được tạo. Vào trang Video và bấm “Chuẩn hoá cho Facebook” trước khi phát.'
              );
        } else {
          uploadResult.innerHTML = alertHtml('error', 'Tải lên không thành công', data.message || `Lỗi ${xhr.status}`);
        }
      });

      xhr.addEventListener('error', () => {
        startBtn.disabled = false;
        cancelBtn.hidden = true;
        uploadResult.innerHTML = alertHtml('error', 'Mất kết nối khi tải lên', 'Hãy thử lại.');
      });

      xhr.send(form);
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (xhr) xhr.abort();
      cancelBtn.hidden = true;
      startBtn.disabled = false;
      progressBox.hidden = true;
      uploadResult.innerHTML = alertHtml('warn', 'Đã huỷ tải lên', 'File tạm trên VPS đã được dọn.');
    });
  }

  // --- import from link ---
  const urlInput = root.querySelector('#link-url');
  const checkBtn = root.querySelector('[data-link-check]');
  const importBtn = root.querySelector('[data-link-import]');
  const linkResult = root.querySelector('[data-link-result]');
  let probed = null;

  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      probed = null;
      importBtn.hidden = true;
      linkResult.innerHTML = '';
      checkBtn.disabled = true;
      checkBtn.textContent = 'Đang kiểm tra…';

      try {
        const data = await fetch('/api/videos/probe-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ server_id: serverId, url: urlInput.value }),
        }).then((r) => r.json());

        if (!data.ok) {
          linkResult.innerHTML = alertHtml('error', 'Link chưa dùng được', data.message);
        } else if (!data.allowed) {
          linkResult.innerHTML = alertHtml('error', 'Không đủ dung lượng VPS', data.message);
        } else {
          probed = data;
          importBtn.hidden = false;
          const lines = [
            `Nguồn: ${data.providerLabel}`,
            `Dung lượng: ${data.sizeLabel}`,
            data.filename ? `Tên file: ${data.filename}` : null,
            data.note,
          ].filter(Boolean);
          linkResult.innerHTML = alertHtml(
            data.reliability === 'medium' ? 'warn' : 'ok',
            'Link đọc được',
            lines.join('\n')
          );
        }
      } catch {
        linkResult.innerHTML = alertHtml('error', 'Không kiểm tra được link', 'Thử lại sau.');
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = 'Kiểm tra link';
      }
    });
  }

  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Đang bắt đầu…';

      try {
        const data = await fetch('/api/videos/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            server_id: serverId,
            url: urlInput.value,
            name: probed && probed.filename,
          }),
        }).then((r) => r.json());

        if (data.ok) {
          setVideo(data.videoId);
          // The download continues on the VPS regardless of this page, so the
          // project can be created right away.
          linkResult.innerHTML = alertHtml(
            'ok',
            'VPS đang tải video về',
            'Đã chọn video này cho project. Bạn có thể bấm “Tạo project” ngay — ' +
              'quá trình tải vẫn tiếp tục trên VPS kể cả khi bạn đóng trình duyệt.'
          );
          importBtn.hidden = true;
        } else {
          linkResult.innerHTML = alertHtml('error', 'Không bắt đầu được', data.error || data.message);
          importBtn.disabled = false;
          importBtn.textContent = 'Bắt đầu tải về VPS';
        }
      } catch {
        linkResult.innerHTML = alertHtml('error', 'Không gửi được yêu cầu', 'Thử lại sau.');
        importBtn.disabled = false;
        importBtn.textContent = 'Bắt đầu tải về VPS';
      }
    });
  }
}

document.querySelectorAll('[data-video-picker]').forEach(initVideoPicker);

// ---------- destination rows & bulk preview ----------

document.querySelectorAll('[data-dest-add]').forEach((button) => {
  button.addEventListener('click', () => {
    const container = document.querySelector('[data-dest-rows]');
    const first = container.querySelector('[data-dest-row]');
    const clone = first.cloneNode(true);
    clone.querySelectorAll('input').forEach((input) => { input.value = ''; });
    container.appendChild(clone);
  });
});

document.querySelectorAll('[data-bulk-preview]').forEach((button) => {
  button.addEventListener('click', async () => {
    const textarea = document.getElementById('destinations_bulk') || document.querySelector('[name="bulk"]');
    const output = document.querySelector('[data-bulk-result]');
    if (!textarea || !output) return;

    output.innerHTML = '';
    try {
      const data = await fetch('/api/destinations/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ text: textarea.value }),
      }).then((r) => r.json());

      if (!data.ok) {
        output.innerHTML = alertHtml('error', 'Không đọc được', data.message);
        return;
      }

      const rows = data.rows
        .map((r) => `<div class="small mono">✓ ${escapeHtml(r.name)} → ${escapeHtml(r.masked)}</div>`)
        .join('');
      const errors = data.errors
        .map((e) => `<div class="small">✕ Dòng ${e.line}: ${escapeHtml(e.message.split('\n')[0])}</div>`)
        .join('');

      output.innerHTML =
        `<div class="alert is-${data.errors.length ? 'warn' : 'ok'}" style="margin-top:0.85rem">` +
        `<strong>${data.rows.length} điểm phát hợp lệ${data.errors.length ? `, ${data.errors.length} dòng lỗi` : ''}</strong>` +
        rows + errors + '</div>';
    } catch {
      output.innerHTML = alertHtml('error', 'Không gửi được yêu cầu', 'Thử lại sau.');
    }
  });
});

/**
 * Only validate the number box that belongs to the selected "Phát trong bao lâu"
 * option.
 *
 * HTML5 validates every input in the form, so a value the user is not even using
 * blocked Save: choosing "Lặp mãi" still failed because the hours box held a number
 * the browser disliked. Disabled inputs are skipped by validation AND left out of the
 * submitted body, which is exactly right — the server reads loop_count/loop_hours
 * only for the mode that was chosen.
 *
 * Progressive enhancement: without this the form still submits, and normalizeLoop on
 * the server is the real gate.
 */
document.addEventListener('DOMContentLoaded', () => {
  const groups = new Map();
  document.querySelectorAll('input[type="radio"][name="loop_mode"]').forEach((radio) => {
    const form = radio.closest('form');
    if (!form) return;
    if (!groups.has(form)) groups.set(form, []);
    groups.get(form).push(radio);
  });

  groups.forEach((radios, form) => {
    const count = form.querySelector('input[name="loop_count"]');
    const hours = form.querySelector('input[name="loop_hours"]');

    const sync = () => {
      const chosen = (radios.find((r) => r.checked) || {}).value;
      if (count) count.disabled = chosen !== 'count';
      if (hours) hours.disabled = chosen !== 'hours';
    };

    radios.forEach((r) => r.addEventListener('change', sync));
    // Typing in a box is a clear signal that this is the option meant, so select it
    // rather than making the user click the radio first and lose what they typed.
    [count, hours].forEach((input) => {
      if (!input) return;
      input.addEventListener('focus', () => {
        const want = input.name === 'loop_count' ? 'count' : 'hours';
        const radio = radios.find((r) => r.value === want);
        if (radio && !radio.checked) { radio.checked = true; sync(); }
      });
    });
    sync();
  });
});
