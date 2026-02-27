/**
 * Builds the window.starknet wallet shim as a self-contained JavaScript string.
 *
 * This is injected via Playwright's addInitScript and runs before any page
 * JavaScript. It implements the StarknetWindowObject interface from
 * get-starknet / @starknet-io/types-js so that DApps cannot distinguish
 * it from a real browser wallet extension.
 *
 * Communication with the Node.js adapter happens exclusively through
 * window.__dappInspector_bridge(call) which is exposed via Playwright's
 * exposeFunction API.
 */

export type ShimInitialState = {
  accounts: string[]
  activeAccount: string | null
  chainId: string
  isConnected: boolean
}

export function buildStarknetShim(initialState: ShimInitialState): string {
  const stateJSON = JSON.stringify(initialState)

  // The entire shim is a self-executing function that captures initial state
  // and sets up the StarknetWindowObject on window.starknet.
  return `(function() {
  "use strict";

  // ── Initial state from adapter ──
  var _initState = ${stateJSON};

  // ── Internal state ──
  var _isConnected = _initState.isConnected;
  var _selectedAddress = _initState.activeAccount || undefined;
  var _chainId = _initState.chainId;
  var _accounts = _initState.accounts || [];
  var _permissions = [];
  var _listeners = { accountsChanged: [], networkChanged: [] };

  // ── Bridge helper ──
  // window.__dappInspector_bridge is exposed by Playwright's exposeFunction.
  // It may not be available immediately on very early page scripts, so we
  // queue calls and replay them once the bridge is ready.
  var _bridgeReady = typeof window.__dappInspector_bridge === "function";
  var _bridgeQueue = [];

  function bridge(call) {
    if (typeof window.__dappInspector_bridge === "function") {
      return window.__dappInspector_bridge(JSON.stringify(call));
    }
    // Bridge not yet available — return a promise that retries
    return new Promise(function(resolve, reject) {
      var attempts = 0;
      var interval = setInterval(function() {
        attempts++;
        if (typeof window.__dappInspector_bridge === "function") {
          clearInterval(interval);
          window.__dappInspector_bridge(JSON.stringify(call)).then(resolve, reject);
        } else if (attempts > 100) {
          clearInterval(interval);
          reject(new Error("dapp-inspector bridge not available"));
        }
      }, 50);
    });
  }

  function callBridge(method, params) {
    return bridge({ method: method, params: params }).then(function(raw) {
      var result = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!result.success) {
        throw new Error(result.error || "Bridge call failed: " + method);
      }
      return result.data;
    });
  }

  // ── Event emitter helpers ──
  function emit(event, data) {
    var handlers = _listeners[event] || [];
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](data); } catch(e) { console.error("[dapp-inspector] event handler error:", e); }
    }
  }

  // ── Provider object ──
  // Proxies RPC calls to the devnet through the bridge
  var provider = {
    getChainId: function() {
      return Promise.resolve(_chainId);
    },
    getBlock: function(blockId) {
      return callBridge("rpcCall", { method: "starknet_getBlockWithTxHashes", params: [blockId || "latest"] });
    },
    getBlockNumber: function() {
      return callBridge("rpcCall", { method: "starknet_blockNumber", params: [] });
    },
    getTransaction: function(txHash) {
      return callBridge("rpcCall", { method: "starknet_getTransactionByHash", params: [txHash] });
    },
    getTransactionReceipt: function(txHash) {
      return callBridge("rpcCall", { method: "starknet_getTransactionReceipt", params: [txHash] });
    },
    getTransactionStatus: function(txHash) {
      return callBridge("rpcCall", { method: "starknet_getTransactionStatus", params: [txHash] });
    },
    callContract: function(call, blockId) {
      return callBridge("rpcCall", {
        method: "starknet_call",
        params: [
          {
            contract_address: call.contractAddress || call.contract_address,
            entry_point_selector: call.entrypoint || call.entry_point_selector,
            calldata: call.calldata || []
          },
          blockId || "latest"
        ]
      });
    },
    getNonce: function(address, blockId) {
      return callBridge("rpcCall", { method: "starknet_getNonce", params: [blockId || "latest", address || _selectedAddress] });
    },
    getStorageAt: function(contractAddress, key, blockId) {
      return callBridge("rpcCall", { method: "starknet_getStorageAt", params: [contractAddress, key, blockId || "latest"] });
    },
    getClassAt: function(contractAddress, blockId) {
      return callBridge("rpcCall", { method: "starknet_getClassAt", params: [blockId || "latest", contractAddress] });
    },
    getClassHashAt: function(contractAddress, blockId) {
      return callBridge("rpcCall", { method: "starknet_getClassHashAt", params: [blockId || "latest", contractAddress] });
    },
    getEstimateFee: function(invocations, blockId) {
      return callBridge("rpcCall", { method: "starknet_estimateFee", params: [invocations, [], blockId || "latest"] });
    },
    chainId: _chainId,
    channel: { nodeUrl: "" },
    waitForTransaction: function(txHash, options) {
      var retryInterval = (options && options.retryInterval) || 2000;
      var maxRetries = 20;
      return new Promise(function(resolve, reject) {
        var retries = 0;
        function check() {
          callBridge("rpcCall", { method: "starknet_getTransactionReceipt", params: [txHash] })
            .then(function(receipt) {
              if (receipt && (receipt.finality_status === "ACCEPTED_ON_L2" || receipt.finality_status === "ACCEPTED_ON_L1" || receipt.execution_status === "SUCCEEDED" || receipt.execution_status === "REVERTED")) {
                resolve(receipt);
              } else if (retries >= maxRetries) {
                resolve(receipt);
              } else {
                retries++;
                setTimeout(check, retryInterval);
              }
            })
            .catch(function(err) {
              if (retries >= maxRetries) {
                reject(err);
              } else {
                retries++;
                setTimeout(check, retryInterval);
              }
            });
        }
        check();
      });
    }
  };

  // ── Account object ──
  // Implements the AccountInterface surface that DApps use to submit transactions
  function buildAccount(address) {
    if (!address) return undefined;

    return {
      address: address,

      execute: function(calls, abis, transactOptions) {
        // Normalize calls to array format
        var callArray = Array.isArray(calls) ? calls : [calls];
        return callBridge("submitTransaction", {
          type: "INVOKE",
          calls: callArray.map(function(c) {
            return {
              contractAddress: c.contractAddress || c.contract_address,
              entrypoint: c.entrypoint || c.entry_point,
              calldata: c.calldata || []
            };
          }),
          options: transactOptions || {}
        }).then(function(result) {
          return { transaction_hash: result.txHash };
        });
      },

      signMessage: function(typedData) {
        return callBridge("signTypedData", { typedData: typedData });
      },

      verifyMessage: function(typedData, signature) {
        // On devnet with test accounts, we return true for simplicity
        return Promise.resolve(true);
      },

      getNonce: function(blockId) {
        return provider.getNonce(address, blockId);
      },

      estimateInvokeFee: function(calls, details) {
        var callArray = Array.isArray(calls) ? calls : [calls];
        return callBridge("rpcCall", {
          method: "starknet_estimateFee",
          params: [[{
            type: "INVOKE",
            sender_address: address,
            calldata: [],
            max_fee: "0x0",
            version: "0x1",
            signature: [],
            nonce: "0x0"
          }], [], "latest"]
        }).then(function(result) {
          var fee = result && result[0];
          return {
            overall_fee: fee ? (fee.overall_fee || fee.gas_consumed || "0x0") : "0x0",
            gas_consumed: fee ? (fee.gas_consumed || "0x0") : "0x0",
            gas_price: fee ? (fee.gas_price || "0x0") : "0x0",
            suggestedMaxFee: fee ? (fee.overall_fee || "0x0") : "0x0"
          };
        });
      },

      estimateDeclareFee: function() {
        return Promise.resolve({ overall_fee: "0x0", gas_consumed: "0x0", gas_price: "0x0", suggestedMaxFee: "0x0" });
      },

      estimateDeployFee: function() {
        return Promise.resolve({ overall_fee: "0x0", gas_consumed: "0x0", gas_price: "0x0", suggestedMaxFee: "0x0" });
      },

      declare: function(contract, options) {
        return callBridge("submitTransaction", {
          type: "DECLARE",
          contract: contract,
          options: options || {}
        }).then(function(result) {
          return { transaction_hash: result.txHash, class_hash: result.classHash || "0x0" };
        });
      },

      deploy: function(payload, options) {
        return callBridge("submitTransaction", {
          type: "DEPLOY",
          payload: payload,
          options: options || {}
        }).then(function(result) {
          return { transaction_hash: result.txHash, contract_address: result.contractAddress || [] };
        });
      },

      getChainId: function() {
        return Promise.resolve(_chainId);
      },

      // starknet.js v6 Account fields
      signer: { getPubKey: function() { return Promise.resolve("0x0"); } },
      provider: provider,
      cairoVersion: "1",
      transactionVersion: "0x3"
    };
  }

  // ── Main StarknetWindowObject ──
  var starknetWallet = {
    id: "dapp-inspector",
    name: "DappInspector Test Wallet",
    version: "1.0.0",
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/></svg>'),

    isConnected: _isConnected,
    selectedAddress: _selectedAddress,
    chainId: _chainId,
    account: buildAccount(_selectedAddress),
    provider: provider,

    // ── enable() — primary connection method ──
    enable: function(options) {
      return callBridge("requestAccounts", options || {}).then(function(data) {
        _isConnected = true;
        _accounts = data.accounts || [];
        _selectedAddress = data.selectedAddress || _accounts[0];
        _chainId = data.chainId || _chainId;
        _permissions = ["accounts"];

        starknetWallet.isConnected = true;
        starknetWallet.selectedAddress = _selectedAddress;
        starknetWallet.chainId = _chainId;
        starknetWallet.account = buildAccount(_selectedAddress);
        starknetWallet.provider.chainId = _chainId;

        emit("accountsChanged", _accounts);
        return _accounts;
      });
    },

    isPreauthorized: function() {
      return Promise.resolve(_isConnected);
    },

    // ── Events ──
    on: function(event, handler) {
      if (_listeners[event]) {
        _listeners[event].push(handler);
      }
    },

    off: function(event, handler) {
      if (_listeners[event]) {
        _listeners[event] = _listeners[event].filter(function(h) { return h !== handler; });
      }
    },

    // ── request() dispatcher (SNIP / wallet RPC) ──
    request: function(call) {
      var type = call.type || call.method;
      var params = call.params || {};

      switch (type) {
        case "wallet_getPermissions":
          return Promise.resolve(_permissions);

        case "wallet_requestAccounts": {
          if (_isConnected) {
            return Promise.resolve(_accounts);
          }
          return starknetWallet.enable().then(function() {
            return _accounts;
          });
        }

        case "wallet_watchAsset":
          return Promise.resolve(true);

        case "wallet_addStarknetChain":
          return Promise.resolve(true);

        case "wallet_switchStarknetChain": {
          var newChainId = params.chainId;
          return callBridge("switchChain", { chainId: newChainId }).then(function(data) {
            _chainId = data.chainId || newChainId;
            starknetWallet.chainId = _chainId;
            starknetWallet.provider.chainId = _chainId;
            emit("networkChanged", _chainId);
            return true;
          });
        }

        case "wallet_requestChainId":
          return Promise.resolve(_chainId);

        case "wallet_deploymentData":
          return Promise.resolve({
            address: _selectedAddress || "0x0",
            class_hash: "0x0",
            salt: "0x0",
            calldata: [],
            sigdata: [],
            version: 1
          });

        case "wallet_addInvokeTransaction": {
          var invokeCalls = params.calls || (params.call ? [params.call] : []);
          return callBridge("submitTransaction", {
            type: "INVOKE",
            calls: invokeCalls.map(function(c) {
              return {
                contractAddress: c.contractAddress || c.contract_address,
                entrypoint: c.entrypoint || c.entry_point,
                calldata: c.calldata || []
              };
            }),
            options: {}
          }).then(function(result) {
            return { transaction_hash: result.txHash };
          });
        }

        case "wallet_addDeclareTransaction": {
          return callBridge("submitTransaction", {
            type: "DECLARE",
            contract: params.contract || params,
            options: {}
          }).then(function(result) {
            return { transaction_hash: result.txHash, class_hash: result.classHash || "0x0" };
          });
        }

        case "wallet_signTypedData": {
          return callBridge("signTypedData", { typedData: params }).then(function(signature) {
            return signature;
          });
        }

        case "wallet_supportedSpecs":
          return Promise.resolve(["0.6", "0.7"]);

        case "wallet_supportedWalletApi":
          return Promise.resolve(["0.7.2"]);

        default:
          return Promise.reject(new Error("Unsupported wallet RPC method: " + type));
      }
    }
  };

  // ── Inject into window ──
  // Set as window.starknet for get-starknet v3+ compatibility
  Object.defineProperty(window, "starknet", {
    value: starknetWallet,
    writable: true,
    configurable: true
  });

  // Also inject into the starknet-specific discovery object
  // get-starknet v4 uses window.starknet_<id> pattern
  Object.defineProperty(window, "starknet_dapp-inspector", {
    value: starknetWallet,
    writable: true,
    configurable: true
  });

  // For SNIP-12 wallet discovery, dispatch the announce event
  try {
    window.dispatchEvent(new CustomEvent("wallet_announced", {
      detail: {
        id: "dapp-inspector",
        name: "DappInspector Test Wallet",
        version: "1.0.0",
        icon: starknetWallet.icon
      }
    }));
  } catch(e) { /* ignore if CustomEvent not supported */ }

  // ── Listen for state updates from the adapter ──
  // The adapter can push state changes to the shim via a custom event
  window.addEventListener("__dappInspector_stateUpdate", function(e) {
    var update = e.detail || {};

    if (update.selectedAddress !== undefined && update.selectedAddress !== _selectedAddress) {
      _selectedAddress = update.selectedAddress;
      starknetWallet.selectedAddress = _selectedAddress;
      starknetWallet.account = buildAccount(_selectedAddress);
      emit("accountsChanged", update.accounts || [_selectedAddress]);
    }

    if (update.chainId !== undefined && update.chainId !== _chainId) {
      _chainId = update.chainId;
      starknetWallet.chainId = _chainId;
      starknetWallet.provider.chainId = _chainId;
      emit("networkChanged", _chainId);
    }

    if (update.isConnected !== undefined) {
      _isConnected = update.isConnected;
      starknetWallet.isConnected = _isConnected;
      if (!_isConnected) {
        _selectedAddress = undefined;
        _accounts = [];
        starknetWallet.selectedAddress = undefined;
        starknetWallet.account = undefined;
        emit("accountsChanged", []);
      }
    }

    if (update.accounts !== undefined) {
      _accounts = update.accounts;
    }
  });

  // Mark shim as ready
  window.__dappInspector_shimReady = true;
  console.log("[dapp-inspector] StarkNet wallet shim injected");
})();`
}
