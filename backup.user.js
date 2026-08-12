// ==UserScript==
// @name         SteamPY CDK 行情助手
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  在库存管理页面快速查看游戏行情（卖家价格与库存），辅助改价决策
// @author       Claude
// @match        https://steampy.com/pyUserInfo/sellerCDKey*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============ 带认证的请求工具 ============
    // 从 Cookie 中读出 accessToken（与 bbsToken 同值），或从用户信息中提取
    function getAccessToken() {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var parts = cookies[i].trim().split('=');
            if (parts[0] === 'bbsToken') return parts.slice(1).join('=');
        }
        return '';
    }

    function apiRequest(url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('accessToken', getAccessToken());
            xhr.withCredentials = true;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error('JSON 解析失败'));
                    }
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function () {
                reject(new Error('网络请求失败'));
            };
            xhr.send();
        });
    }

    // ============ 数据缓存 ============
    // gameName → { gameId, stock, total, keyPrice, discount }
    const gameCache = new Map();
    let mySellerId = null;

    // ============ API 拦截：捕获库存列表数据 ============
    function handleListSelfResponse(data) {
        if (!data.success || !data.result || !data.result.content) return;
        data.result.content.forEach(function (item) {
            if (!mySellerId && item.sellerId) {
                mySellerId = item.sellerId;
            }
            if (item.steamGame && item.steamGame.gameName) {
                gameCache.set(item.steamGame.gameName, {
                    gameId: item.gameId,
                    stock: item.stock,
                    total: item.total,
                    keyPrice: item.keyPrice,
                    discount: item.discount,
                });
            }
        });
    }

    // 拦截 fetch
    var origFetch = window.fetch.bind(window);
    window.fetch = function (url) {
        var promise = origFetch.apply(this, arguments);
        if (typeof url === 'string' && url.indexOf('/steamKeySale/listSelf') !== -1) {
            promise.then(function (resp) {
                if (resp.ok) {
                    resp.clone().json().then(handleListSelfResponse).catch(function () {});
                }
            }).catch(function () {});
        }
        return promise;
    };

    // 拦截 XMLHttpRequest
    var XHR = XMLHttpRequest.prototype;
    var origOpen = XHR.open;
    var origSend = XHR.send;
    XHR.open = function (method, url) {
        this.__spy_url = url;
        return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
        var xhr = this;
        xhr.addEventListener('load', function () {
            if (xhr.__spy_url && xhr.__spy_url.indexOf('/steamKeySale/listSelf') !== -1) {
                try {
                    handleListSelfResponse(JSON.parse(xhr.responseText));
                } catch (e) {}
            }
        });
        return origSend.apply(xhr, arguments);
    };

    // ============ UI 元素（延迟创建） ============
    var panelEl = null;
    var overlayEl = null;

    function injectStyles() {
        var style = document.createElement('style');
        style.textContent = [
            '/* 行情按钮 */',
            '.spy-market-btn { cursor: pointer; user-select: none; }',
            '.spy-market-btn:hover { opacity: 0.7; }',
            '.spy-market-btn .btnInfo { font-size: 13px; }',

            '/* 遮罩 */',
            '#spy-market-overlay {',
            '  position: fixed; top: 0; left: 0; width: 100%; height: 100%;',
            '  background: rgba(0,0,0,0.3); z-index: 9998;',
            '  opacity: 0; visibility: hidden;',
            '  transition: opacity 0.3s, visibility 0.3s;',
            '}',
            '#spy-market-overlay.show { opacity: 1; visibility: visible; }',

            '/* 侧边面板 */',
            '#spy-market-panel {',
            '  position: fixed; top: 0; right: -430px; width: 400px; height: 100vh;',
            '  background: #fff; z-index: 9999;',
            '  box-shadow: -2px 0 16px rgba(0,0,0,0.12);',
            '  transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);',
            '  display: flex; flex-direction: column;',
            '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
            '}',
            '#spy-market-panel.open { right: 0; }',

            '/* 面板头部 */',
            '#spy-panel-header {',
            '  padding: 18px 20px; border-bottom: 1px solid #eee;',
            '  display: flex; justify-content: space-between; align-items: flex-start;',
            '  background: #fafafa; flex-shrink: 0;',
            '}',
            '#spy-panel-title {',
            '  font-size: 15px; font-weight: 600; color: #1a1a1a;',
            '  display: block; margin-bottom: 4px;',
            '}',
            '#spy-panel-subtitle {',
            '  font-size: 12px; color: #999; display: block;',
            '}',
            '#spy-panel-close {',
            '  background: none; border: none; font-size: 18px; cursor: pointer;',
            '  color: #bbb; padding: 0 4px; line-height: 1;',
            '  transition: color 0.2s;',
            '}',
            '#spy-panel-close:hover { color: #333; }',

            '/* 面板内容区 */',
            '#spy-panel-body { flex: 1; overflow-y: auto; position: relative; }',
            '#spy-panel-body .spy-table {',
            '  width: 100%; border-collapse: collapse; font-size: 13px;',
            '}',
            '#spy-panel-body .spy-table thead th {',
            '  padding: 10px 16px; color: #888; font-weight: 500; font-size: 12px;',
            '  background: #fafafa; position: sticky; top: 0; z-index: 2;',
            '  border-bottom: 2px solid #eee;',
            '}',
            '#spy-panel-body .spy-table tbody td {',
            '  padding: 10px 16px; border-bottom: 1px solid #f5f5f5;',
            '  transition: background 0.15s;',
            '}',
            '#spy-panel-body .spy-table tbody tr:hover td { background: #fafafa; }',
            '#spy-panel-body .spy-table .row-mine td { background: #e6f7ff; }',
            '#spy-panel-body .spy-table .row-mine:hover td { background: #d6efff; }',
            '.spy-price-mine { color: #1890ff; font-weight: 600; }',
            '.spy-price-best { color: #e60012; font-weight: 500; }',
            '.spy-price-normal { color: #333; }',

            '/* 加载遮罩 */',
            '#spy-panel-loading {',
            '  display: none; position: absolute; top: 50%; left: 50%;',
            '  transform: translate(-50%,-50%); text-align: center; color: #bbb;',
            '  font-size: 14px;',
            '}',
            '#spy-panel-loading .spinner {',
            '  display: inline-block; width: 28px; height: 28px;',
            '  border: 3px solid #eee; border-top-color: #1890ff;',
            '  border-radius: 50%; animation: spy-spin 0.6s linear infinite;',
            '  margin-bottom: 8px;',
            '}',
            '@keyframes spy-spin { to { transform: rotate(360deg); } }',
            '#spy-panel-loading.show { display: block; }',

            '/* 面板底部 */',
            '#spy-panel-footer {',
            '  padding: 10px 20px; border-top: 1px solid #eee;',
            '  font-size: 11px; color: #bbb; text-align: center; flex-shrink: 0;',
            '}',

            '/* 响应式：窄屏时面板收窄 */',
            '@media (max-width: 500px) {',
            '  #spy-market-panel { width: 100vw; right: -100vw; }',
            '}',
        ].join('\n');
        document.head.appendChild(style);
    }

    function buildPanel() {
        if (panelEl) return;

        // 遮罩层
        overlayEl = document.createElement('div');
        overlayEl.id = 'spy-market-overlay';
        overlayEl.addEventListener('click', closePanel);
        document.body.appendChild(overlayEl);

        // 侧边面板
        panelEl = document.createElement('div');
        panelEl.id = 'spy-market-panel';
        panelEl.innerHTML =
            '<div id="spy-panel-header">' +
            '  <div>' +
            '    <span id="spy-panel-title"></span>' +
            '    <span id="spy-panel-subtitle"></span>' +
            '  </div>' +
            '  <button id="spy-panel-close" title="关闭">✕</button>' +
            '</div>' +
            '<div id="spy-panel-body">' +
            '  <table class="spy-table">' +
            '    <thead><tr>' +
            '      <th style="width:44px;text-align:center;">#</th>' +
            '      <th style="text-align:right;">库存</th>' +
            '      <th style="text-align:right;width:110px;">CDKEY单价</th>' +
            '    </tr></thead>' +
            '    <tbody id="spy-panel-tbody"></tbody>' +
            '  </table>' +
            '  <div id="spy-panel-loading">' +
            '    <div class="spinner"></div>加载中...' +
            '  </div>' +
            '</div>' +
            '<div id="spy-panel-footer">数据来自 SteamPY · 价格从低到高排列</div>';
        document.body.appendChild(panelEl);

        document.getElementById('spy-panel-close').addEventListener('click', closePanel);
    }

    // ============ 业务逻辑 ============
    function openPanel(gameName) {
        buildPanel();

        var info = gameCache.get(gameName);
        if (!info) {
            // 缓存未命中，主动请求库存数据
            apiRequest('/xboot/steamKeySale/listSelf?pageNumber=1&pageSize=50&sort=saleStatus&order=desc')
                .then(function (data) {
                    handleListSelfResponse(data);
                    var fresh = gameCache.get(gameName);
                    if (fresh) {
                        showPanel(gameName, fresh);
                    } else {
                        alert('未找到游戏 "' + gameName + '" 的数据，请刷新页面后重试。');
                    }
                })
                .catch(function () {
                    alert('获取库存数据失败，请检查网络后重试。');
                });
            return;
        }

        showPanel(gameName, info);
    }

    function showPanel(gameName, info) {
        // 设置头部信息
        document.getElementById('spy-panel-title').textContent = gameName;
        document.getElementById('spy-panel-subtitle').textContent =
            '你的库存: ' + info.stock + '/' + info.total +
            ' · 售价: ¥' + info.keyPrice.toFixed(2);

        // 显示加载状态
        var loading = document.getElementById('spy-panel-loading');
        var tbody = document.getElementById('spy-panel-tbody');
        loading.classList.add('show');
        tbody.innerHTML = '';

        // 滑出面板
        panelEl.classList.add('open');
        overlayEl.classList.add('show');

        // 请求行情数据
        var apiUrl = '/xboot/steamKeySale/listSale' +
            '?pageNumber=1&pageSize=20&sort=keyPrice&order=asc' +
            '&startDate=&endDate=&gameId=' + info.gameId;

        apiRequest(apiUrl)
            .then(function (data) {
                loading.classList.remove('show');

                if (!data.success || !data.result || !data.result.content) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:36px;color:#bbb;">数据格式异常，请稍后重试</td></tr>';
                    return;
                }

                var items = data.result.content;
                if (items.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:36px;color:#bbb;">暂无其他卖家在售</td></tr>';
                    return;
                }

                tbody.innerHTML = items.map(function (item, i) {
                    var isMine = mySellerId && item.sellerId === mySellerId;
                    var priceClass = isMine ? 'spy-price-mine' : (i === 0 ? 'spy-price-best' : 'spy-price-normal');
                    var rowClass = isMine ? 'row-mine' : '';
                    return '<tr class="' + rowClass + '">' +
                        '<td style="text-align:center;color:#bbb;font-size:12px;">' + (i + 1) + '</td>' +
                        '<td style="text-align:right;">' + (item.stock != null ? item.stock : '-') + '</td>' +
                        '<td style="text-align:right;" class="' + priceClass + '">¥' + ((item.keyPrice || 0).toFixed(2)) + '</td>' +
                        '</tr>';
                }).join('');
            })
            .catch(function (err) {
                loading.classList.remove('show');
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:36px;color:#e60012;">加载失败: ' + err.message + '</td></tr>';
            });
    }

    function closePanel() {
        if (!panelEl) return;
        panelEl.classList.remove('open');
        overlayEl.classList.remove('show');
    }

    // ============ 按钮注入 ============
    function isSellerCDKeyPage() {
        return window.location.pathname.indexOf('/sellerCDKey') !== -1;
    }

    function injectButtons() {
        if (!isSellerCDKeyPage()) return;

        var rows = document.querySelectorAll('.list-item');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            // 避免重复注入
            if (row.querySelector('.spy-market-btn')) continue;

            var nameEl = row.querySelector('.steamGameName');
            if (!nameEl) continue;
            var gameName = nameEl.textContent.trim();

            // 找到「改价」按钮所在容器
            var allBtnInfos = row.querySelectorAll('.btnInfo');
            var targetContainer = null;
            for (var j = 0; j < allBtnInfos.length; j++) {
                if (allBtnInfos[j].textContent.trim() === '改价') {
                    targetContainer = allBtnInfos[j].closest('.color-blue');
                    break;
                }
            }
            if (!targetContainer) continue;
            var actionArea = targetContainer.parentElement;
            if (!actionArea) continue;

            // 创建「行情」按钮
            var btnWrapper = document.createElement('div');
            btnWrapper.className = 'color-blue spy-market-btn';
            btnWrapper.innerHTML = '<span class="btnInfo">行情</span>';
            btnWrapper.addEventListener('click', function (name) {
                return function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    openPanel(name);
                };
            }(gameName));

            actionArea.appendChild(btnWrapper);
        }
    }

    // ============ 启动 ============
    function initDOM() {
        injectStyles();
        buildPanel();
        injectButtons();

        // 监听 DOM 变化（SPA 页面切换、翻页等场景自动重新注入按钮）
        new MutationObserver(function () {
            if (isSellerCDKeyPage()) injectButtons();
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDOM);
    } else {
        initDOM();
    }
})();