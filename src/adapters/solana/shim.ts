import type { WalletState } from "../interface.js"

export function buildSolanaShim(initialState: WalletState): string {
  const stateJSON = JSON.stringify(initialState)

  return `(function() {
  "use strict";

  // ── Internal state ──
  var state = ${stateJSON};
  var listeners = { connect: [], disconnect: [], accountChanged: [] };

  // ── Bridge helper ──
  function callBridge(method, params) {
    if (typeof window.__dappInspector_bridge !== "function") {
      return Promise.reject(new Error("dapp-inspector bridge not available"));
    }
    return window.__dappInspector_bridge(JSON.stringify({ method: method, params: params }))
      .then(function(raw) {
        var result = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!result.success) {
          throw new Error(result.error || "Bridge call failed");
        }
        return result.data;
      });
  }

  function emit(event, data) {
    var handlers = listeners[event] || [];
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](data); } catch(e) { console.error("[dapp-inspector] event handler error:", e); }
    }
  }

  // ── PublicKey polyfill (minimal, for DApp compatibility) ──
  function SolPublicKey(value) {
    if (value instanceof SolPublicKey) {
      this._base58 = value._base58;
      this._bytes = value._bytes;
      return;
    }
    if (typeof value === "string") {
      this._base58 = value;
      this._bytes = null;
    } else if (value instanceof Uint8Array) {
      this._bytes = value;
      this._base58 = null;
    } else {
      throw new Error("Invalid public key input");
    }
  }

  // Base58 alphabet for encoding/decoding
  var BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58Encode(bytes) {
    if (bytes.length === 0) return "";
    var zeroes = 0;
    var length = 0;
    var pbegin = 0;
    var pend = bytes.length;
    while (pbegin !== pend && bytes[pbegin] === 0) { pbegin++; zeroes++; }
    var size = ((pend - pbegin) * 138 / 100) + 1 >>> 0;
    var b58 = new Uint8Array(size);
    while (pbegin !== pend) {
      var carry = bytes[pbegin];
      var i = 0;
      for (var it = size - 1; (carry !== 0 || i < length) && (it !== -1); it--, i++) {
        carry += (256 * b58[it]) >>> 0;
        b58[it] = (carry % 58) >>> 0;
        carry = (carry / 58) >>> 0;
      }
      length = i;
      pbegin++;
    }
    var it2 = size - length;
    while (it2 !== size && b58[it2] === 0) { it2++; }
    var str = "";
    for (var k = 0; k < zeroes; k++) { str += "1"; }
    for (; it2 < size; it2++) { str += BASE58_ALPHABET.charAt(b58[it2]); }
    return str;
  }

  function base58Decode(str) {
    if (str.length === 0) return new Uint8Array(0);
    var zeroes = 0;
    var length = 0;
    var pbegin = 0;
    var pend = str.length;
    while (pbegin !== pend && str[pbegin] === "1") { pbegin++; zeroes++; }
    var size = ((pend - pbegin) * 733 / 1000) + 1 >>> 0;
    var b256 = new Uint8Array(size);
    while (pbegin !== pend) {
      var carry = BASE58_ALPHABET.indexOf(str[pbegin]);
      if (carry < 0) throw new Error("Invalid base58 character");
      var i = 0;
      for (var it = size - 1; (carry !== 0 || i < length) && (it !== -1); it--, i++) {
        carry += (58 * b256[it]) >>> 0;
        b256[it] = (carry % 256) >>> 0;
        carry = (carry / 256) >>> 0;
      }
      length = i;
      pbegin++;
    }
    var it2 = size - length;
    while (it2 !== size && b256[it2] === 0) { it2++; }
    var result = new Uint8Array(zeroes + (size - it2));
    for (var k = 0; k < zeroes; k++) result[k] = 0;
    var j = zeroes;
    while (it2 !== size) { result[j++] = b256[it2++]; }
    return result;
  }

  SolPublicKey.prototype.toBase58 = function() {
    if (this._base58) return this._base58;
    this._base58 = base58Encode(this._bytes);
    return this._base58;
  };

  SolPublicKey.prototype.toString = function() {
    return this.toBase58();
  };

  SolPublicKey.prototype.toJSON = function() {
    return this.toBase58();
  };

  SolPublicKey.prototype.toBytes = function() {
    if (this._bytes) return this._bytes;
    this._bytes = base58Decode(this._base58);
    return this._bytes;
  };

  SolPublicKey.prototype.equals = function(other) {
    return this.toBase58() === other.toBase58();
  };

  Object.defineProperty(SolPublicKey.prototype, "byteLength", {
    get: function() { return 32; }
  });

  // ── Transaction serialization helpers ──
  function serializeTransaction(tx) {
    // Check if it's a VersionedTransaction (has message.serialize)
    if (tx && tx.message && typeof tx.message.serialize === "function") {
      // VersionedTransaction
      var serialized = tx.serialize();
      return { data: uint8ArrayToBase64(serialized), encoding: "base64", versioned: true };
    }
    // Legacy Transaction
    if (tx && typeof tx.serialize === "function") {
      try {
        // Try to serialize (may fail if not fully signed)
        var serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        return { data: uint8ArrayToBase64(serialized), encoding: "base64", versioned: false };
      } catch(e) {
        // Fallback: serialize the message only
        if (tx.serializeMessage) {
          var msg = tx.serializeMessage();
          return { data: uint8ArrayToBase64(msg), encoding: "base64", versioned: false, messageOnly: true };
        }
      }
    }
    throw new Error("Cannot serialize transaction: unsupported format");
  }

  function uint8ArrayToBase64(uint8) {
    var binary = "";
    for (var i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  }

  function base64ToUint8Array(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ── Sync state from bridge ──
  function syncState() {
    return callBridge("getState").then(function(s) {
      state = s;
    });
  }

  // ── Provider object ──
  var provider = {
    isPhantom: true,
    _isSolanaProvider: true,

    get publicKey() {
      if (!state.isConnected || !state.activeAccount) return null;
      return new SolPublicKey(state.activeAccount);
    },

    get isConnected() {
      return state.isConnected;
    },

    connect: function(options) {
      if (state.isConnected && state.activeAccount) {
        var pk = new SolPublicKey(state.activeAccount);
        return Promise.resolve({ publicKey: pk });
      }

      return callBridge("connect", {
        onlyIfTrusted: options && options.onlyIfTrusted
      }).then(function(data) {
        state.isConnected = true;
        state.activeAccount = data.address;
        state.chainId = data.chainId || null;
        var pk = new SolPublicKey(data.address);
        emit("connect", pk);
        return { publicKey: pk };
      });
    },

    disconnect: function() {
      return callBridge("disconnect").then(function() {
        state.isConnected = false;
        state.activeAccount = null;
        emit("disconnect");
      });
    },

    signTransaction: function(tx) {
      var serialized = serializeTransaction(tx);
      return callBridge("signTransaction", {
        tx: serialized.data,
        encoding: serialized.encoding,
        versioned: serialized.versioned,
        messageOnly: serialized.messageOnly || false,
      }).then(function(data) {
        // The adapter returns the signed transaction as base64
        // We need to reconstruct the transaction object
        if (data.signedTx) {
          var signedBytes = base64ToUint8Array(data.signedTx);
          // Reassemble signatures onto the original transaction
          if (tx && tx.addSignature && data.signature) {
            var sigBytes = base64ToUint8Array(data.signature);
            var feePayer = tx.feePayer || (state.activeAccount ? new SolPublicKey(state.activeAccount) : null);
            if (feePayer) {
              tx.addSignature(feePayer, Buffer.from ? Buffer.from(sigBytes) : sigBytes);
            }
            return tx;
          }
          // For VersionedTransaction, we get back the full signed tx
          if (data.versioned && tx.constructor && tx.constructor.deserialize) {
            return tx.constructor.deserialize(signedBytes);
          }
          // Fallback: try to set the signature directly
          if (data.signature && tx.signatures && tx.signatures.length > 0) {
            var sigBytes2 = base64ToUint8Array(data.signature);
            tx.signatures[0] = sigBytes2;
          }
        }
        return tx;
      });
    },

    signAllTransactions: function(txs) {
      var serializedArray = txs.map(function(tx) { return serializeTransaction(tx); });
      var txDataArray = serializedArray.map(function(s) {
        return { data: s.data, encoding: s.encoding, versioned: s.versioned, messageOnly: s.messageOnly || false };
      });

      return callBridge("signAllTransactions", { transactions: txDataArray })
        .then(function(data) {
          // data.signatures is an array of base64 signature strings
          if (data.signatures && Array.isArray(data.signatures)) {
            for (var i = 0; i < txs.length; i++) {
              if (data.signatures[i]) {
                var sigBytes = base64ToUint8Array(data.signatures[i]);
                if (txs[i].addSignature) {
                  var feePayer = txs[i].feePayer || (state.activeAccount ? new SolPublicKey(state.activeAccount) : null);
                  if (feePayer) {
                    txs[i].addSignature(feePayer, Buffer.from ? Buffer.from(sigBytes) : sigBytes);
                  }
                } else if (txs[i].signatures && txs[i].signatures.length > 0) {
                  txs[i].signatures[0] = sigBytes;
                }
              }
            }
          }
          return txs;
        });
    },

    signAndSendTransaction: function(tx, options) {
      var serialized = serializeTransaction(tx);
      return callBridge("submitTransaction", {
        tx: serialized.data,
        encoding: serialized.encoding,
        versioned: serialized.versioned,
        messageOnly: serialized.messageOnly || false,
        sendOptions: options || {},
      }).then(function(data) {
        return { signature: data.signature, publicKey: data.publicKey || state.activeAccount };
      });
    },

    signMessage: function(message) {
      var msgBytes;
      if (message instanceof Uint8Array) {
        msgBytes = uint8ArrayToBase64(message);
      } else if (typeof message === "string") {
        // Encode string to bytes then base64
        var encoder = new TextEncoder();
        msgBytes = uint8ArrayToBase64(encoder.encode(message));
      } else {
        msgBytes = uint8ArrayToBase64(new Uint8Array(message));
      }

      return callBridge("signMessage", { message: msgBytes }).then(function(data) {
        var sigBytes = base64ToUint8Array(data.signature);
        return { signature: sigBytes };
      });
    },

    on: function(event, handler) {
      if (listeners[event]) {
        listeners[event].push(handler);
      }
    },

    off: function(event, handler) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(function(h) { return h !== handler; });
      }
    },

    // Some DApps also check for these
    request: function(req) {
      if (req.method === "connect") return provider.connect(req.params);
      if (req.method === "disconnect") return provider.disconnect();
      if (req.method === "signTransaction") return provider.signTransaction(req.params.transaction || req.params);
      if (req.method === "signAndSendTransaction") return provider.signAndSendTransaction(req.params.transaction || req.params, req.params.options);
      if (req.method === "signMessage") return provider.signMessage(req.params.message || req.params);
      return Promise.reject(new Error("Unsupported method: " + req.method));
    },
  };

  // ── Register on window.solana ──
  Object.defineProperty(window, "solana", {
    value: provider,
    writable: false,
    configurable: true,
  });

  // ── Wallet Standard registration ──
  // Register via the wallet-standard WindowRegisterWalletEvent pattern
  // DApps using @solana/wallet-adapter-react listen for this
  try {
    var SOLANA_MAINNET = "solana:mainnet";
    var SOLANA_DEVNET = "solana:devnet";
    var SOLANA_TESTNET = "solana:testnet";
    var SOLANA_LOCALNET = "solana:localnet";

    var walletAccount = null;

    function makeAccount() {
      if (!state.isConnected || !state.activeAccount) return null;
      var pk = new SolPublicKey(state.activeAccount);
      return {
        address: state.activeAccount,
        publicKey: pk.toBytes(),
        chains: [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET, SOLANA_LOCALNET],
        features: [
          "standard:connect",
          "standard:disconnect",
          "standard:events",
          "solana:signTransaction",
          "solana:signAndSendTransaction",
          "solana:signMessage",
        ],
      };
    }

    var walletStandardObj = {
      version: "1.0.0",
      name: "dapp-inspector (Phantom)",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzk5NDVGRiIvPjwvc3ZnPg==",
      chains: [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET, SOLANA_LOCALNET],
      features: {
        "standard:connect": {
          version: "1.0.0",
          connect: function() {
            return provider.connect().then(function(result) {
              walletAccount = makeAccount();
              return { accounts: walletAccount ? [walletAccount] : [] };
            });
          },
        },
        "standard:disconnect": {
          version: "1.0.0",
          disconnect: function() {
            return provider.disconnect().then(function() {
              walletAccount = null;
            });
          },
        },
        "standard:events": {
          version: "1.0.0",
          on: function(event, listener) {
            if (event === "change") {
              provider.on("connect", function() {
                walletAccount = makeAccount();
                listener({ accounts: walletAccount ? [walletAccount] : [] });
              });
              provider.on("disconnect", function() {
                walletAccount = null;
                listener({ accounts: [] });
              });
              provider.on("accountChanged", function() {
                walletAccount = makeAccount();
                listener({ accounts: walletAccount ? [walletAccount] : [] });
              });
            }
            return function() {};
          },
        },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: function() {
            var inputs = arguments[0];
            var promises = [];
            for (var i = 0; i < inputs.length; i++) {
              (function(input) {
                var txBytes = input.transaction;
                var txBase64 = uint8ArrayToBase64(txBytes);
                promises.push(
                  callBridge("signTransaction", {
                    tx: txBase64,
                    encoding: "base64",
                    versioned: true,
                    messageOnly: false,
                  }).then(function(data) {
                    return { signedTransaction: base64ToUint8Array(data.signedTx) };
                  })
                );
              })(inputs[i]);
            }
            return Promise.all(promises);
          },
        },
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signAndSendTransaction: function() {
            var inputs = arguments[0];
            var promises = [];
            for (var i = 0; i < inputs.length; i++) {
              (function(input) {
                var txBytes = input.transaction;
                var txBase64 = uint8ArrayToBase64(txBytes);
                promises.push(
                  callBridge("submitTransaction", {
                    tx: txBase64,
                    encoding: "base64",
                    versioned: true,
                    messageOnly: false,
                  }).then(function(data) {
                    return { signature: base58Decode(data.signature) };
                  })
                );
              })(inputs[i]);
            }
            return Promise.all(promises);
          },
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: function() {
            var inputs = arguments[0];
            var promises = [];
            for (var i = 0; i < inputs.length; i++) {
              (function(input) {
                var msgBase64 = uint8ArrayToBase64(input.message);
                promises.push(
                  callBridge("signMessage", { message: msgBase64 }).then(function(data) {
                    return { signedMessage: input.message, signature: base64ToUint8Array(data.signature) };
                  })
                );
              })(inputs[i]);
            }
            return Promise.all(promises);
          },
        },
      },
      get accounts() {
        return walletAccount ? [walletAccount] : [];
      },
    };

    // Dispatch the wallet-standard register event
    var registerEvent = new CustomEvent("wallet-standard:register-wallet", {
      detail: Object.freeze({ register: function(callback) { callback(walletStandardObj); } }),
    });
    window.dispatchEvent(registerEvent);

    // Also listen for future requests
    window.addEventListener("wallet-standard:app-ready", function(event) {
      if (event.detail && typeof event.detail.register === "function") {
        event.detail.register(walletStandardObj);
      }
    });
  } catch(e) {
    console.warn("[dapp-inspector] Wallet Standard registration failed:", e);
  }

  // ── Dispatch PhantomEvent so DApps detect the provider ──
  try {
    window.dispatchEvent(new Event("solana#initialized"));
  } catch(e) {}

})();`
}
