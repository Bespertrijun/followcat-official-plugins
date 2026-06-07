// devrt plugin-sdk.js — drop-in replacement for the host's /plugin-sdk.js
// Exposes the same FC.* surface used in production:
//   FC.ready()                → Promise<ctx>
//   FC.api(path, body)        → Promise<any>
//   FC.config.get(key)        → Promise<string|null>
//   FC.config.put(key, value, isSecret) → Promise<void>
//   FC.notify(level, message) → Promise<void>
//   FC.resize(height)         → Promise<void>
//
// All calls go through window.parent via postMessage. The DevRT host shell
// (devrt/host.html) listens, forwards to the FastAPI server, and responds.
(function (global) {
  'use strict';

  var pending = {};
  var nextId = 1;
  var ctx = null;
  var readyResolvers = [];

  function send(type, payload) {
    var id = String(nextId++);
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      var msg = {
        protocol: 'followcat.plugin.v1',
        type: type,
        id: id,
        payload: payload || null,
      };
      try {
        parent.postMessage(msg, '*');
      } catch (e) {
        delete pending[id];
        reject(e);
        return;
      }
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('postMessage timeout: ' + type));
        }
      }, 30000);
    });
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || msg.protocol !== 'followcat.plugin.v1') return;

    if (msg.type === 'host.init') {
      ctx = msg.payload || {};
      var rs = readyResolvers;
      readyResolvers = [];
      for (var i = 0; i < rs.length; i++) rs[i](ctx);
      return;
    }

    if (msg.id && pending[msg.id]) {
      var p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  global.FC = {
    ready: function () {
      if (ctx) return Promise.resolve(ctx);
      return new Promise(function (resolve) { readyResolvers.push(resolve); });
    },
    api: function (path, body) {
      return send('plugin.api', { path: path, body: body == null ? null : body });
    },
    config: {
      get: function (key) {
        return send('plugin.config.get', { key: key });
      },
      put: function (key, value, isSecret) {
        return send('plugin.config.put', { key: key, value: value, is_secret: !!isSecret });
      },
    },
    notify: function (level, message) {
      return send('plugin.notify', { level: level, message: message });
    },
    resize: function (height) {
      return send('plugin.resize', { height: height });
    },
  };
})(window);
