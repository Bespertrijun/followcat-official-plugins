(function(window) {
    var pendingRPCs = {}, requestId = 0;

    function nextId() { return 'rpc_' + (++requestId); }

    function rpc(type, payload) {
        return new Promise(function(resolve, reject) {
            var id = nextId();
            pendingRPCs[id] = { resolve: resolve, reject: reject };
            window.parent.postMessage({ id: id, type: type, payload: payload }, '*');
        });
    }

    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (!msg || !msg.id) return;
        var p = pendingRPCs[msg.id];
        if (!p) return;
        delete pendingRPCs[msg.id];
        if (msg.error) p.reject(new Error(msg.error.message || msg.error));
        else p.resolve(msg.result);
    });

    var initPromise = rpc('fc.init', null);

    // NOTE: Do NOT call fetch() / XMLHttpRequest from here.
    // CSP connect-src 'none' blocks it. All host comms go through postMessage.
    window.FC = {
        ready: function() { return initPromise; },
        api:   function(path, body) { return rpc('api.call', { path: path, body: body }); },
        config: {
            get: function(key)                  { return rpc('config.get', { key: key }); },
            put: function(key, value, isSecret) { return rpc('config.put', { key: key, value: value, is_secret: !!isSecret }); }
        },
        notify: function(level, msg)  { return rpc('host.notify', { level: level, message: msg }); },
        resize: function(height)      { return rpc('host.resize', { height: height }); }
    };
})(window);
