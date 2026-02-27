/**
 * Builds the window.ethereum shim as a self-executing vanilla JS string.
 * This script is injected into the browser via Playwright's addInitScript.
 * It must be entirely self-contained — no imports, no external dependencies.
 */

export type ShimInitialState = {
  accounts: string[]
  chainId: string // hex, e.g. "0x7a69"
  isConnected: boolean
}

export function buildEvmShim(
  initialState: ShimInitialState,
  devnetUrl: string,
  chainId: number,
): string {
  // Serialize initial state into the script
  const stateJson = JSON.stringify(initialState)
  const chainIdHex = "0x" + chainId.toString(16)

  return `(function() {
  "use strict";

  // ── Internal state ──
  var state = ${stateJson};
  var _chainId = "${chainIdHex}";
  var _devnetUrl = ${JSON.stringify(devnetUrl)};
  var _listeners = {};
  var _rpcId = 0;

  // ── Event system ──
  function emit(event, data) {
    var handlers = _listeners[event] || [];
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](data); } catch(e) { console.error("[DappInspector] event handler error:", e); }
    }
  }

  // ── Bridge call helper ──
  function bridgeCall(method, params) {
    if (typeof window.__dappInspector_bridge === "function") {
      return window.__dappInspector_bridge(JSON.stringify({ method: method, params: params }));
    }
    return Promise.reject(new Error("DappInspector bridge not available"));
  }

  // ── Devnet RPC proxy ──
  function rpcProxy(method, params) {
    _rpcId++;
    return fetch(_devnetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: _rpcId,
        method: method,
        params: params || []
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      if (json.error) {
        var err = new Error(json.error.message || "RPC error");
        err.code = json.error.code || -32603;
        err.data = json.error.data;
        throw err;
      }
      return json.result;
    });
  }

  // ── EIP-1193 request dispatcher ──
  function request(args) {
    var method = args.method;
    var params = args.params || [];

    switch (method) {

      // ── Account methods ──
      case "eth_accounts":
        return Promise.resolve(state.isConnected ? state.accounts.slice() : []);

      case "eth_requestAccounts":
        if (state.isConnected && state.accounts.length > 0) {
          return Promise.resolve(state.accounts.slice());
        }
        return bridgeCall("requestAccounts", {}).then(function(result) {
          if (result.success && result.data) {
            state.isConnected = true;
            state.accounts = result.data.accounts || [];
            _chainId = result.data.chainId || _chainId;
            emit("connect", { chainId: _chainId });
            emit("accountsChanged", state.accounts.slice());
            return state.accounts.slice();
          }
          var err = new Error(result.error || "User rejected connection");
          err.code = 4001;
          throw err;
        });

      // ── Chain ID methods ──
      case "eth_chainId":
        return Promise.resolve(_chainId);

      case "net_version":
        return Promise.resolve(String(parseInt(_chainId, 16)));

      // ── Transaction methods ──
      case "eth_sendTransaction":
        return bridgeCall("sendTransaction", params[0]).then(function(result) {
          if (result.success) return result.data.txHash;
          var err = new Error(result.error || "Transaction rejected");
          err.code = 4001;
          throw err;
        });

      // ── Signing methods ──
      case "eth_sign":
        return bridgeCall("sign", { address: params[0], message: params[1] }).then(function(result) {
          if (result.success) return result.data.signature;
          var err = new Error(result.error || "Sign rejected");
          err.code = 4001;
          throw err;
        });

      case "personal_sign":
        return bridgeCall("personalSign", { message: params[0], address: params[1] }).then(function(result) {
          if (result.success) return result.data.signature;
          var err = new Error(result.error || "Sign rejected");
          err.code = 4001;
          throw err;
        });

      case "eth_signTypedData_v4":
        return bridgeCall("signTypedData", { address: params[0], typedData: params[1] }).then(function(result) {
          if (result.success) return result.data.signature;
          var err = new Error(result.error || "Sign rejected");
          err.code = 4001;
          throw err;
        });

      // ── Wallet methods ──
      case "wallet_switchEthereumChain":
        var requestedChainId = params[0] && params[0].chainId;
        return bridgeCall("switchChain", { chainId: requestedChainId }).then(function(result) {
          if (result.success) {
            _chainId = result.data.chainId;
            emit("chainChanged", _chainId);
            return null;
          }
          var err = new Error(result.error || "Chain switch failed");
          err.code = 4902;
          throw err;
        });

      case "wallet_addEthereumChain":
        return Promise.resolve(null);

      case "wallet_watchAsset":
        return Promise.resolve(true);

      // ── Proxy methods to devnet RPC ──
      case "eth_getBalance":
      case "eth_call":
      case "eth_estimateGas":
      case "eth_gasPrice":
      case "eth_blockNumber":
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
      case "eth_getTransactionReceipt":
      case "eth_getTransactionCount":
      case "eth_getTransactionByHash":
      case "eth_getCode":
      case "eth_getStorageAt":
      case "eth_getLogs":
      case "eth_feeHistory":
      case "eth_maxPriorityFeePerGas":
        return rpcProxy(method, params);

      // ── Default: proxy unrecognized methods to devnet ──
      default:
        return rpcProxy(method, params);
    }
  }

  // ── Build the provider object ──
  var provider = {
    isMetaMask: true,
    _isDappInspector: true,

    isConnected: function() {
      return state.isConnected;
    },

    request: request,

    on: function(event, listener) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(listener);
      return provider;
    },

    removeListener: function(event, listener) {
      if (!_listeners[event]) return provider;
      _listeners[event] = _listeners[event].filter(function(l) { return l !== listener; });
      return provider;
    },

    // Alias for removeListener
    off: function(event, listener) {
      return provider.removeListener(event, listener);
    },

    removeAllListeners: function(event) {
      if (event) {
        delete _listeners[event];
      } else {
        _listeners = {};
      }
      return provider;
    },

    // Legacy send method
    send: function(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === "string") {
        return request({ method: methodOrPayload, params: paramsOrCallback || [] });
      }
      // Legacy payload format
      return request({ method: methodOrPayload.method, params: methodOrPayload.params || [] })
        .then(function(result) {
          if (typeof paramsOrCallback === "function") {
            paramsOrCallback(null, { id: methodOrPayload.id, jsonrpc: "2.0", result: result });
          }
          return result;
        })
        .catch(function(err) {
          if (typeof paramsOrCallback === "function") {
            paramsOrCallback(err);
          }
          throw err;
        });
    },

    // Legacy sendAsync method
    sendAsync: function(payload, callback) {
      request({ method: payload.method, params: payload.params || [] })
        .then(function(result) {
          callback(null, { id: payload.id, jsonrpc: "2.0", result: result });
        })
        .catch(function(err) {
          callback(err);
        });
    },

    // Internal: called by bridge to update state from adapter side
    _updateState: function(newState) {
      var oldAccounts = state.accounts.slice();
      var oldChainId = _chainId;

      if (newState.accounts !== undefined) state.accounts = newState.accounts;
      if (newState.isConnected !== undefined) state.isConnected = newState.isConnected;
      if (newState.chainId !== undefined) _chainId = newState.chainId;

      // Emit events for changes
      if (JSON.stringify(oldAccounts) !== JSON.stringify(state.accounts)) {
        emit("accountsChanged", state.accounts.slice());
      }
      if (oldChainId !== _chainId) {
        emit("chainChanged", _chainId);
      }
      if (newState.isConnected === false && state.isConnected !== false) {
        emit("disconnect", { code: 4900, message: "Disconnected" });
      }
      if (newState.isConnected === true) {
        emit("connect", { chainId: _chainId });
      }
    },

    // EIP-1102 (deprecated but still used)
    enable: function() {
      return request({ method: "eth_requestAccounts" });
    },

    // selectedAddress property (some DApps check this)
    get selectedAddress() {
      return state.isConnected && state.accounts.length > 0 ? state.accounts[0] : null;
    },

    get chainId() {
      return _chainId;
    },

    get networkVersion() {
      return String(parseInt(_chainId, 16));
    }
  };

  // ── Assign to window.ethereum ──
  Object.defineProperty(window, "ethereum", {
    value: provider,
    writable: false,
    configurable: true,
    enumerable: true
  });

  // ── EIP-6963 support ──
  var providerInfo = {
    uuid: "dapp-inspector-evm",
    name: "DappInspector Test Wallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjNjM2NkYxIi8+PHRleHQgeD0iMTYiIHk9IjIyIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSIgZm9udC1zaXplPSIxNiIgZm9udC1mYW1pbHk9Im1vbm9zcGFjZSI+REk8L3RleHQ+PC9zdmc+",
    rdns: "io.dapp-inspector.wallet"
  };

  function announceProvider() {
    var event = new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({
        info: Object.freeze(providerInfo),
        provider: provider
      })
    });
    window.dispatchEvent(event);
  }

  // Announce on load
  announceProvider();

  // Re-announce when requested
  window.addEventListener("eip6963:requestProvider", function() {
    announceProvider();
  });

  // Log for debugging
  console.log("[DappInspector] EVM wallet shim injected (chainId: " + _chainId + ", accounts: " + state.accounts.length + ")");
})();`
}
