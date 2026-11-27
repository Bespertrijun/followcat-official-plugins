(function(window) {
    var pendingRPCs = {}, requestId = 0;
    var currentTheme = null;
    var themeListeners = [];

    function nextId() { return 'rpc_' + (++requestId); }

    function normalizeTheme(t) {
        return (t === 'dark' || t === 'light') ? t : null;
    }

    function applyTheme(t) {
        var next = normalizeTheme(t);
        if (!next) return;
        if (window.document && window.document.documentElement) {
            window.document.documentElement.setAttribute('data-theme', next);
        }
        if (next === currentTheme) return;
        currentTheme = next;
        var list = themeListeners.slice();
        for (var i = 0; i < list.length; i++) {
            try { list[i](next); } catch (e) {}
        }
    }

    function readInitialTheme() {
        try {
            var search = window.location && window.location.search;
            if (!search) return null;
            var m = /(?:^|[?&])fcTheme=([^&]+)/.exec(search);
            return m ? normalizeTheme(decodeURIComponent(m[1])) : null;
        } catch (e) {
            return null;
        }
    }

    function rpc(type, payload) {
        return new Promise(function(resolve, reject) {
            var id = nextId();
            pendingRPCs[id] = { resolve: resolve, reject: reject };
            window.parent.postMessage({ id: id, type: type, payload: payload }, '*');
        });
    }

    window.addEventListener('message', function(e) {
        if (e.source !== window.parent) return;
        var msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        if (!msg.id) {
            if (msg.type === 'host.theme' && msg.payload) {
                applyTheme(msg.payload.theme);
            }
            return;
        }
        var p = pendingRPCs[msg.id];
        if (!p) return;
        delete pendingRPCs[msg.id];
        if (msg.error) p.reject(new Error(msg.error.message || msg.error));
        else p.resolve(msg.result);
    });

    // Apply ?fcTheme= synchronously in <head> before first paint to avoid flashing.
    applyTheme(readInitialTheme());

    var initPromise = rpc('fc.init', null).then(function(ctx) {
        if (ctx && ctx.theme) applyTheme(ctx.theme);
        return ctx;
    });

    // NOTE: Do NOT call fetch() / XMLHttpRequest from here.
    // CSP connect-src 'none' blocks it. All host comms go through postMessage.
    window.FC = {
        ready: function() { return initPromise; },
        api:   function(path, body) { return rpc('api.call', { path: path, body: body }); },
        config: {
            get: function(key)                  { return rpc('config.get', { key: key }); },
            put: function(key, value, isSecret) { return rpc('config.put', { key: key, value: value, is_secret: !!isSecret }); },
            // resolves { deleted: bool } — whether a stored key was actually removed
            delete: function(key)               { return rpc('config.delete', { key: key }); }
        },
        notify: function(level, msg)  { return rpc('host.notify', { level: level, message: msg }); },
        resize: function(height)      { return rpc('host.resize', { height: height }); },
        onThemeChange: function(cb) {
            if (typeof cb !== 'function') return function() {};
            themeListeners.push(cb);
            return function() {
                var idx = themeListeners.indexOf(cb);
                if (idx >= 0) themeListeners.splice(idx, 1);
            };
        }
    };
})(window);
