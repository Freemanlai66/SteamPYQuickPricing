// ==UserScript==
// @name         SteamPY CDK 行情助手
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  在库存管理页面快速查看游戏行情，最低价时按钮变绿。支持国区/全球区切换。
// @author       Claude
// @match        https://steampy.com/pyUserInfo/sellerCDKey*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============ 请求工具 ============
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
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (e) { reject(new Error('JSON error')); }
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function () { reject(new Error('Network error')); };
            xhr.send();
        });
    }

    // ============ 区域感知 ============
    // 从 HTML 中区域标签判断当前是哪个区
    // 页面上有 tab：国区 / 俄区 / 全球区，选中的 tab 有个 active 类
    function detectRegion() {
        // 尝试从页面的 tab 找到当前激活的区域
        var tabs = document.querySelectorAll('.el-tabs__item, .tab-item, [class*="tab"]');
        for (var i = 0; i < tabs.length; i++) {
            var t = tabs[i];
            var text = t.textContent.trim();
            if ((text === '国区' || text === 'cn' || text === '中国') && (t.classList.contains('is-active') || t.classList.contains('active') || t.parentElement && t.parentElement.classList.contains('active'))) {
                return 'cn';
            }
        }
        // 如果找不到选中 tab，看看 URL hash 参数
        if (window.location.hash.indexOf('us') !== -1 || window.location.hash.indexOf('global') !== -1) return 'us';
        if (window.location.hash.indexOf('ru') !== -1) return 'ru';
        // 默认国区
        return 'cn';
    }

    function getBasePath() {
        var region = detectRegion();
        if (region === 'us') return '/xboot/usKeySale';
        if (region === 'ru') return '/xboot/ruKeySale';
        return '/xboot/steamKeySale';
    }

    function listSelfUrl() {
        return getBasePath() + '/listSelf?pageNumber=1&pageSize=50&sort=saleStatus&order=desc';
    }

    function listSaleUrl(gameId) {
        return getBasePath() + '/listSale?pageNumber=1&pageSize=20&sort=keyPrice&order=asc&startDate=&endDate=&gameId=' + gameId;
    }

    // ============ 数据缓存 ============
    var gameCache = new Map();      // gameName -> { gameId, stock, total, keyPrice, discount }
    var priceStatus = new Map();    // gameName -> 'lowest' | 'not-lowest' | 'loading'
    var mySellerId = null;

    // ============ API 拦截 ============
    function handleListSelfResponse(data) {
        if (!data.success || !data.result || !data.result.content) return;
        gameCache.clear();
        priceStatus.clear();
        var items = data.result.content;
        for (var k = 0; k < items.length; k++) {
            var item = items[k];
            if (!mySellerId && item.sellerId) mySellerId = item.sellerId;
            if (item.steamGame && item.steamGame.gameName) {
                gameCache.set(item.steamGame.gameName, {
                    gameId: item.gameId,
                    stock: item.stock,
                    total: item.total,
                    keyPrice: item.keyPrice,
                    discount: item.discount
                });
            }
        }
        scheduleBackgroundCheck();
    }

    function isListSelfUrl(url) {
        return url.indexOf('/steamKeySale/listSelf') !== -1 ||
               url.indexOf('/usKeySale/listSelf') !== -1 ||
               url.indexOf('/ruKeySale/listSelf') !== -1;
    }

    // 拦截 fetch
    var origFetch = window.fetch.bind(window);
    window.fetch = function (url) {
        var promise = origFetch.apply(this, arguments);
        var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');
        if (isListSelfUrl(urlStr)) {
            promise.then(function (resp) {
                if (resp.ok) resp.clone().json().then(handleListSelfResponse).catch(function () {});
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
            if (xhr.__spy_url && isListSelfUrl(xhr.__spy_url)) {
                try { handleListSelfResponse(JSON.parse(xhr.responseText)); } catch (e) {}
            }
        });
        return origSend.apply(xhr, arguments);
    };

    // ============ 后台批量价格检查 ============
    var checkTimer = null;

    function scheduleBackgroundCheck() {
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(runBackgroundCheck, 600);
    }

    function runBackgroundCheck() {
        var games = Array.from(gameCache.entries());
        var idx = 0;

        function checkNext() {
            if (idx >= games.length) return;
            var entry = games[idx++];
            var gameName = entry[0];
            var info = entry[1];

            if (priceStatus.has(gameName)) {
                checkNext();
                return;
            }
            priceStatus.set(gameName, 'loading');

            apiRequest(listSaleUrl(info.gameId)).then(function (data) {
                if (!data.success || !data.result || !data.result.content || data.result.content.length === 0) {
                    priceStatus.set(gameName, 'lowest');
                } else {
                    var lowestPrice = data.result.content[0].keyPrice;
                    priceStatus.set(gameName, info.keyPrice <= lowestPrice ? 'lowest' : 'not-lowest');
                }
                updateButtonStyle(gameName);
            }).catch(function () {
                priceStatus.delete(gameName);
            }).then(function () {
                setTimeout(checkNext, 800);
            });
        }

        checkNext();
        setTimeout(checkNext, 200);
        setTimeout(checkNext, 400);
    }

    // ============ UI 元素 ============
    var panelEl = null;
    var overlayEl = null;

    function injectStyles() {
        var css = '';
        css += '.spy-market-btn{cursor:pointer;user-select:none;}';
        css += '.spy-market-btn:hover{opacity:0.7;}';
        css += '.spy-market-btn .btnInfo{font-size:13px;}';
        css += '.spy-market-btn.is-lowest{color:#52c41a !important;}';
        css += '.spy-refresh-bar{position:fixed;top:12px;right:12px;z-index:9997;display:flex;align-items:center;gap:8px;}';
        css += '.spy-refresh-btn{background:#1890ff;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;transition:background .2s;}';
        css += '.spy-refresh-btn:hover{background:#40a9ff;}';
        css += '.spy-refresh-btn:active{background:#096dd9;}';
        css += '.spy-refresh-btn.busy{opacity:0.6;pointer-events:none;}';
        css += '.spy-refresh-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:6px;}';
        css += '.spy-refresh-dot.idle{background:#bbb;}';
        css += '.spy-refresh-dot.ok{background:#52c41a;}';
        css += '#spy-market-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:9998;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s;}';
        css += '#spy-market-overlay.show{opacity:1;visibility:visible;}';
        css += '#spy-market-panel{position:fixed;top:0;right:-430px;width:400px;height:100vh;background:#fff;z-index:9999;box-shadow:-2px 0 16px rgba(0,0,0,0.12);transition:right .3s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;}';
        css += '#spy-market-panel.open{right:0;}';
        css += '#spy-panel-header{padding:18px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:flex-start;background:#fafafa;flex-shrink:0;}';
        css += '#spy-panel-title{font-size:15px;font-weight:600;color:#1a1a1a;display:block;margin-bottom:4px;}';
        css += '#spy-panel-subtitle{font-size:12px;color:#999;display:block;}';
        css += '#spy-panel-close{background:none;border:none;font-size:18px;cursor:pointer;color:#bbb;padding:0 4px;line-height:1;transition:color .2s;}';
        css += '#spy-panel-close:hover{color:#333;}';
        css += '#spy-panel-body{flex:1;overflow-y:auto;position:relative;}';
        css += '#spy-panel-body .spy-table{width:100%;border-collapse:collapse;font-size:13px;}';
        css += '#spy-panel-body .spy-table thead th{padding:10px 16px;color:#888;font-weight:500;font-size:12px;background:#fafafa;position:sticky;top:0;z-index:2;border-bottom:2px solid #eee;}';
        css += '#spy-panel-body .spy-table tbody td{padding:10px 16px;border-bottom:1px solid #f5f5f5;transition:background .15s;}';
        css += '#spy-panel-body .spy-table tbody tr:hover td{background:#fafafa;}';
        css += '#spy-panel-body .spy-table .row-mine td{background:#e6f7ff;}';
        css += '#spy-panel-body .spy-table .row-mine:hover td{background:#d6efff;}';
        css += '.spy-price-mine{color:#1890ff;font-weight:600;}';
        css += '.spy-price-best{color:#e60012;font-weight:500;}';
        css += '.spy-price-normal{color:#333;}';
        css += '#spy-panel-loading{display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#bbb;font-size:14px;}';
        css += '#spy-panel-loading .spinner{display:inline-block;width:28px;height:28px;border:3px solid #eee;border-top-color:#1890ff;border-radius:50%;animation:spy-spin .6s linear infinite;margin-bottom:8px;}';
        css += '@keyframes spy-spin{to{transform:rotate(360deg);}}';
        css += '#spy-panel-loading.show{display:block;}';
        css += '#spy-panel-footer{padding:10px 20px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;flex-shrink:0;}';
        css += '@media (max-width:500px){#spy-market-panel{width:100vw;right:-100vw;}}';

        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    function buildPanel() {
        if (panelEl) return;
        overlayEl = document.createElement('div');
        overlayEl.id = 'spy-market-overlay';
        overlayEl.addEventListener('click', closePanel);
        document.body.appendChild(overlayEl);

        panelEl = document.createElement('div');
        panelEl.id = 'spy-market-panel';
        panelEl.innerHTML =
            '<div id="spy-panel-header">' +
            '  <div>' +
            '    <span id="spy-panel-title"></span>' +
            '    <span id="spy-panel-subtitle"></span>' +
            '  </div>' +
            '  <button id="spy-panel-close">X</button>' +
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
            '  <div id="spy-panel-loading"><div class="spinner"></div>加载中...</div>' +
            '</div>' +
            '<div id="spy-panel-footer">数据来自 SteamPY · 价格从低到高</div>';
        document.body.appendChild(panelEl);
        document.getElementById('spy-panel-close').addEventListener('click', closePanel);
    }

    // ============ 浮动刷新按钮 ============
    var refreshBarEl = null;
    var refreshDotEl = null;
    var refreshPending = 0;

    function buildRefreshBar() {
        if (refreshBarEl) return;
        refreshBarEl = document.createElement('div');
        refreshBarEl.className = 'spy-refresh-bar';
        refreshBarEl.innerHTML =
            '<button class="spy-refresh-btn" id="spy-refresh-btn">' +
            '刷新行情<span id="spy-refresh-dot" class="spy-refresh-dot idle"></span>' +
            '</button>';
        document.body.appendChild(refreshBarEl);
        refreshDotEl = document.getElementById('spy-refresh-dot');
        document.getElementById('spy-refresh-btn').addEventListener('click', fullRefresh);
    }

    function fullRefresh() {
        var btn = document.getElementById('spy-refresh-btn');
        if (btn.classList.contains('busy')) return;

        gameCache.clear();
        priceStatus.clear();

        var allBtns = document.querySelectorAll('.spy-market-btn.is-lowest');
        for (var i = 0; i < allBtns.length; i++) {
            allBtns[i].classList.remove('is-lowest');
        }

        btn.classList.add('busy');
        btn.textContent = '刷新中...';
        refreshPending = 0;

        apiRequest(listSelfUrl())
            .then(function (data) {
                if (data.success && data.result && data.result.content) {
                    handleListSelfResponse(data);
                    waitForRefreshDone(btn);
                } else {
                    btn.classList.remove('busy');
                    btn.innerHTML = '刷新行情<span class="spy-refresh-dot idle"></span>';
                    refreshDotEl = document.getElementById('spy-refresh-dot');
                }
            })
            .catch(function () {
                btn.classList.remove('busy');
                btn.innerHTML = '刷新失败<span class="spy-refresh-dot idle"></span>';
                refreshDotEl = document.getElementById('spy-refresh-dot');
            });
    }

    function waitForRefreshDone(btn) {
        var entries = Array.from(gameCache.entries());
        var totalChecked = 0;
        for (var i = 0; i < entries.length; i++) {
            var status = priceStatus.get(entries[i][0]);
            if (status === 'lowest' || status === 'not-lowest') totalChecked++;
        }

        if (countLoading() > 0) {
            refreshPending = entries.length - totalChecked;
            setTimeout(function () { waitForRefreshDone(btn); }, 500);
        } else {
            btn.classList.remove('busy');
            btn.innerHTML = '刷新行情<span class="spy-refresh-dot ok"></span>';
            refreshDotEl = document.getElementById('spy-refresh-dot');
            refreshPending = 0;
            setTimeout(function () {
                if (refreshDotEl) refreshDotEl.className = 'spy-refresh-dot idle';
            }, 2000);
        }
    }

    function countLoading() {
        var count = 0;
        var vals = priceStatus.values();
        var v = vals.next();
        while (!v.done) {
            if (v.value === 'loading') count++;
            v = vals.next();
        }
        return count;
    }

    // ============ 面板与按钮 ============
    function openPanel(gameName) {
        buildPanel();
        var info = gameCache.get(gameName);
        if (!info) {
            // 缓存未命中：用当前区域的 listSelf API 重新拉取
            apiRequest(listSelfUrl())
                .then(function (data) {
                    handleListSelfResponse(data);
                    var fresh = gameCache.get(gameName);
                    if (fresh) showPanel(gameName, fresh);
                    else alert('未找到游戏 "' + gameName + '" 的数据，请点击刷新按钮。');
                })
                .catch(function () { alert('获取库存数据失败'); });
            return;
        }
        showPanel(gameName, info);
    }

    function showPanel(gameName, info) {
        document.getElementById('spy-panel-title').textContent = gameName;
        document.getElementById('spy-panel-subtitle').textContent =
            '你的库存: ' + info.stock + '/' + info.total + ' · 售价: Y' + info.keyPrice.toFixed(2);

        var loading = document.getElementById('spy-panel-loading');
        var tbody = document.getElementById('spy-panel-tbody');
        loading.classList.add('show');
        tbody.innerHTML = '';
        panelEl.classList.add('open');
        overlayEl.classList.add('show');

        apiRequest(listSaleUrl(info.gameId)).then(function (data) {
            loading.classList.remove('show');
            if (!data.success || !data.result || !data.result.content) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:36px;color:#bbb;">数据异常</td></tr>';
                return;
            }
            var items = data.result.content;
            if (items.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:36px;color:#bbb;">暂无其他卖家</td></tr>';
                priceStatus.set(gameName, 'lowest');
                updateButtonStyle(gameName);
                return;
            }

            var lowestPrice = items[0].keyPrice;
            priceStatus.set(gameName, info.keyPrice <= lowestPrice ? 'lowest' : 'not-lowest');
            updateButtonStyle(gameName);

            tbody.innerHTML = items.map(function (item, i) {
                var isMine = mySellerId && item.sellerId === mySellerId;
                var priceClass = isMine ? 'spy-price-mine' : (i === 0 ? 'spy-price-best' : 'spy-price-normal');
                var rowClass = isMine ? 'row-mine' : '';
                return '<tr class="' + rowClass + '">' +
                    '<td style="text-align:center;color:#bbb;font-size:12px;">' + (i + 1) + '</td>' +
                    '<td style="text-align:right;">' + (item.stock != null ? item.stock : '-') + '</td>' +
                    '<td style="text-align:right;" class="' + priceClass + '">Y' + ((item.keyPrice || 0).toFixed(2)) + '</td>' +
                    '</tr>';
            }).join('');
        }).catch(function (err) {
            loading.classList.remove('show');
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:36px;color:#e60012;">加载失败: ' + err.message + '</td></tr>';
        });
    }

    function closePanel() {
        if (!panelEl) return;
        panelEl.classList.remove('open');
        overlayEl.classList.remove('show');
    }

    // ============ 按钮绿色更新 ============
    function updateButtonStyle(gameName) {
        var rows = document.querySelectorAll('.list-item');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var nameEl = row.querySelector('.steamGameName');
            if (!nameEl) continue;
            if (nameEl.textContent.trim() !== gameName) continue;
            var btn = row.querySelector('.spy-market-btn');
            if (!btn) continue;
            var status = priceStatus.get(gameName);
            if (status === 'lowest') {
                btn.classList.add('is-lowest');
            } else {
                btn.classList.remove('is-lowest');
            }
            break;
        }
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
            if (row.querySelector('.spy-market-btn')) continue;
            var nameEl = row.querySelector('.steamGameName');
            if (!nameEl) continue;
            var gameName = nameEl.textContent.trim();

            var allBtns = row.querySelectorAll('.btnInfo');
            var target = null;
            for (var j = 0; j < allBtns.length; j++) {
                if (allBtns[j].textContent.trim() === '改价') {
                    target = allBtns[j].closest('.color-blue');
                    break;
                }
            }
            if (!target) continue;
            var area = target.parentElement;
            if (!area) continue;

            var btn = document.createElement('div');
            btn.className = 'color-blue spy-market-btn';
            if (priceStatus.get(gameName) === 'lowest') {
                btn.classList.add('is-lowest');
            }
            btn.innerHTML = '<span class="btnInfo">行情</span>';
            btn.addEventListener('click', (function (name) {
                return function (e) { e.stopPropagation(); e.preventDefault(); openPanel(name); };
            })(gameName));
            area.appendChild(btn);
        }
    }

    // ============ 监听区域切换 ============
    function observeRegionChange() {
        // 监听 tab 点击来检测区域切换
        document.addEventListener('click', function (e) {
            var target = e.target;
            // 检查点击的元素是不是 tab（可能点击了 tab 文本或包裹的 span）
            var tab = target.closest('.el-tabs__item') || target.closest('[class*="tab"]');
            if (!tab) return;
            var text = tab.textContent.trim();
            // 判断是不是区域 tab
            if (text === '国区' || text === '全球区' || text === '俄区' || text === 'cn' || text === 'us' || text === 'ru' || text === '中国') {
                // 等 Vue 渲染完后再刷新
                setTimeout(function () {
                    gameCache.clear();
                    priceStatus.clear();
                    var allBtns = document.querySelectorAll('.spy-market-btn.is-lowest');
                    for (var i = 0; i < allBtns.length; i++) {
                        allBtns[i].classList.remove('is-lowest');
                    }
                    // 主动请求当前区域库存
                    apiRequest(listSelfUrl())
                        .then(function (data) { handleListSelfResponse(data); })
                        .catch(function () {});
                }, 500);
            }
        }, true);
    }

    // ============ 启动 ============
    function initDOM() {
        injectStyles();
        buildPanel();
        buildRefreshBar();
        injectButtons();
        observeRegionChange();
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