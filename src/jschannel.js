// jschannel-react-native.js

/*
 * js_channel (modified for React Native WebView)
 * Lightweight abstraction on top of postMessage for rich interactions.
 * Supports: query/response, query/update/response, notifications, error handling.
 * Based on json-rpc, focused on inter-window/WebView RPC.
 *
 * Modifications for react-native-webview:
 * - Handles window.ReactNativeWebView for posting messages.
 * - Adjusts origin and source handling in s_onMessage.
 * - Modifies postMessage calls to use the correct signature for ReactNativeWebView.
 * - Allows 'react-native-webview' as a valid origin.
 * - Bypasses some checks (like window === cfg.window) when in RN environment.
 * - Adds a 'force' flag to postMessage calls originating from callbacks/ready state changes
 * to potentially bypass 'ready' checks in the RN context.
 */

; var Channel = (function () {
    "use strict";

    // current transaction id
    var s_curTranId = Math.floor(Math.random() * 1000001);

    // bound channels table
    var s_boundChans = {};

    // add a channel to s_boundChans
    function s_addBoundChan(win, origin, scope, handler) {
        function hasWin(arr) {
            // In RN WebView, 'win' might be the ReactNativeWebView object, not a WindowProxy
            for (var i = 0; i < arr.length; i++) if (arr[i].win === win) return true;
            return false;
        }

        var exists = false;

        if (origin === '*') {
            for (var k in s_boundChans) {
                if (!s_boundChans.hasOwnProperty(k)) continue;
                if (k === '*') continue;
                if (typeof s_boundChans[k][scope] === 'object') {
                    exists = hasWin(s_boundChans[k][scope]);
                    if (exists) break;
                }
            }
        } else {
            // Check '*' first
            if (s_boundChans['*'] && s_boundChans['*'][scope]) {
                exists = hasWin(s_boundChans['*'][scope]);
            }
            // Check specific origin if '*' didn't match or doesn't exist
            if (!exists && s_boundChans[origin] && s_boundChans[origin][scope]) {
                exists = hasWin(s_boundChans[origin][scope]);
            }
        }

        if (exists) throw "A channel is already bound to the same window/interface which overlaps with origin '" + origin + "' and has scope '" + scope + "'";

        if (typeof s_boundChans[origin] != 'object') s_boundChans[origin] = {};
        if (typeof s_boundChans[origin][scope] != 'object') s_boundChans[origin][scope] = [];
        s_boundChans[origin][scope].push({ win: win, handler: handler });
    }

    // remove a channel from s_boundChans
    function s_removeBoundChan(win, origin, scope) {
        if (s_boundChans[origin] && s_boundChans[origin][scope]) {
            var arr = s_boundChans[origin][scope];
            for (var i = 0; i < arr.length; i++) {
                if (arr[i].win === win) {
                    arr.splice(i, 1);
                    break; // Assume only one instance per win/origin/scope
                }
            }
            if (arr.length === 0) {
                delete s_boundChans[origin][scope];
                // Optional: Clean up origin if empty
                // if (Object.keys(s_boundChans[origin]).length === 0) {
                //     delete s_boundChans[origin];
                // }
            }
        }
    }

    // check if is array helper
    function s_isArray(obj) {
        if (Array.isArray) return Array.isArray(obj);
        else {
            return (obj.constructor.toString().indexOf("Array") != -1);
        }
    }

    // outstanding transaction table
    var s_transIds = {};

    // global message handler
    var s_onMessage = function (e) {
        var m;
        try {
            m = JSON.parse(e.data);
            if (typeof m !== 'object' || m === null) throw "malformed";
        } catch (err) {
            // Ignore non-JSON messages
            return;
        }

        var w, o, s, i, meth;

        // Adapt for react-native-webview environment
        if (window.ReactNativeWebView) {
            o = '*'; // Origin isn't typically provided or meaningful in RNWebView postMessage
            w = window.ReactNativeWebView; // The interface object acts as the 'window'
        } else {
            o = e.origin;
            w = e.source;
        }
        // Extract scope and method
        if (typeof m.method === 'string') {
            var ar = m.method.split('::');
            if (ar.length == 2) { s = ar[0]; meth = ar[1]; }
            else { s = ''; meth = m.method; }
        }
        if (typeof m.id !== 'undefined') i = m.id;

        // Route message based on properties
        if (typeof meth === 'string') {
            // Request or Notification
            var delivered = false;
            // Check specific origin first (standard behavior)
            if (s_boundChans[o] && s_boundChans[o][s]) {
                for (var j = 0; j < s_boundChans[o][s].length; j++) {
                    if (s_boundChans[o][s][j].win === w) {
                        s_boundChans[o][s][j].handler(o, meth, m);
                        delivered = true;
                        break;
                    }
                }
            }
            // If not delivered, check wildcard origin '*' (common for RNWebView)
            if (!delivered && s_boundChans['*'] && s_boundChans['*'][s]) {
                for (var j = 0; j < s_boundChans['*'][s].length; j++) {
                    if (s_boundChans['*'][s][j].win === w) {
                        s_boundChans['*'][s][j].handler(o, meth, m);
                        delivered = true; // Mark delivered even if via wildcard
                        break;
                    }
                }
            }
            // if (!delivered) {
            //     console.debug("jschannel: dropped message, no handler for", o, s, meth, w);
            // }
        } else if (typeof i !== 'undefined') {
            // Response, Error, or Callback Invocation
            if (s_transIds[i]) {
                // Pass origin (o), method (meth will be undefined here), and message (m)
                s_transIds[i](o, meth, m);
            }
            // else {
            //    console.debug("jschannel: dropped message, unknown transaction id:", i);
            // }
        }
        // else {
        //    console.debug("jschannel: dropped message, missing method and id:", m);
        // }
    };

    // Setup postMessage event listeners
    if (window.addEventListener) window.addEventListener('message', s_onMessage, false);
    else if (window.attachEvent) window.attachEvent('onmessage', s_onMessage);

    // Channel builder
    return {
        build: function (cfg) {
            var chanId = (function () {
                var text = "";
                var alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                for (var i = 0; i < 5; i++) text += alpha.charAt(Math.floor(Math.random() * alpha.length));
                return text;
            })();

            var debug = function (m) {
                if (cfg.debugOutput && window.console && window.console.log) {
                    try { if (typeof m !== 'string') m = JSON.stringify(m); } catch (e) { /* ignore */ }
                }
            };

            /* Capability checks */
            // window.postMessage is not the primary mechanism in RNWebView, ReactNativeWebView.postMessage is.
            // Allow build to proceed if ReactNativeWebView is present.
            var hasPostMessage = !!(window.postMessage || window.ReactNativeWebView);
            if (!hasPostMessage) throw ("jschannel cannot run this environment, no postMessage or ReactNativeWebView found");
            if (!window.JSON || !window.JSON.stringify || !window.JSON.parse) {
                throw ("jschannel cannot run this browser, no JSON support");
            }

            /* Basic argument validation */
            if (typeof cfg !== 'object' || cfg === null) throw ("Channel build invoked without a config object");

            var isReactNativeWebView = !!window.ReactNativeWebView;

            if (isReactNativeWebView) {
                // In RNWebView, the 'window' is the ReactNativeWebView object itself
                if (!window.ReactNativeWebView.postMessage || typeof window.ReactNativeWebView.postMessage !== 'function') {
                    throw ("ReactNativeWebView.postMessage is not a function");
                }
                cfg.window = window.ReactNativeWebView;
                // Default origin for RN WebView if not specified, '*' is safer than a specific string
                if (typeof cfg.origin === 'undefined') cfg.origin = '*';
            } else {
                // Standard browser environment
                if (!cfg.window || typeof cfg.window.postMessage !== 'function') {
                    throw ("Channel.build() called without a valid window argument");
                }
                if (window === cfg.window) throw ("Target window is same as present window -- not allowed");
                // Require explicit origin in standard env
                if (typeof cfg.origin !== 'string') throw ("Channel.build() requires an origin argument"); 
            }

            // Validate scope
            var scope = ''; // Default scope is empty string
            if (typeof cfg.scope !== 'undefined') {
                if (typeof cfg.scope !== 'string') throw 'scope, when specified, must be a string';
                if (cfg.scope.split('::').length > 1) throw "scope may not contain double colons: '::'";
                scope = cfg.scope; // Use provided scope
            }
            debug("Final scope for this instance: '" + scope + "'");

            var regTbl = {}; var outTbl = {}; var inTbl = {};
            var ready = false; var pendingQueue = [];

            // Transaction creation logic
            var createTransaction = function (id, origin, callbacks) {
                var shouldDelayReturn = false;
                var completed = false;
                var localDebug = function (m) { debug("transaction(" + id + "): " + m); };

                return {
                    origin: origin,
                    invoke: function (cbName, v) {
                        if (completed) { localDebug("Warning: invoke called after completion"); return; }
                        if (!inTbl[id]) { localDebug("Warning: invoke called for nonexistent transaction"); return; }
                        var valid = false;
                        for (var i = 0; i < callbacks.length; i++) if (cbName === callbacks[i]) { valid = true; break; }
                        if (!valid) throw "Request supports no such callback '" + cbName + "'";
                        postMessage({ id: id, callback: cbName, params: v }, isReactNativeWebView);
                    },
                    error: function (error, message) {
                        if (completed) { localDebug("Warning: error called after completion"); return; }
                        completed = true;
                        if (!inTbl[id]) { localDebug("Warning: error called for nonexistent transaction"); return; }
                        delete inTbl[id];
                        postMessage({ id: id, error: error, message: message }, isReactNativeWebView);
                    },
                    complete: function (v) {
                        if (completed) { localDebug("Warning: complete called after completion"); return; }
                        completed = true;
                        if (!inTbl[id]) { localDebug("Warning: complete called for nonexistent transaction"); return; }
                        delete inTbl[id];
                        // Don't delete from s_transIds here
                        postMessage({ id: id, result: v }, isReactNativeWebView); // Force post in RN
                    },
                    delayReturn: function (delay) {
                        if (typeof delay === 'boolean') { shouldDelayReturn = (delay === true); }
                        return shouldDelayReturn;
                    },
                    completed: function () {
                        return completed;
                    }
                };
            };

            // Timeout handler for outbound requests
            var setTransactionTimeout = function (transId, timeout, method) {
                return window.setTimeout(function () {
                    if (outTbl[transId]) {
                        var msg = "timeout (" + timeout + "ms) exceeded on method '" + method + "'";
                        debug(msg + " for transaction " + transId);
                        try {
                            // Ensure error callback exists before calling
                            if (typeof outTbl[transId].error === 'function') {
                                outTbl[transId].error("timeout_error", msg);
                            }
                        } catch (e) {
                            debug("Exception executing timeout handler: " + e);
                        } finally {
                            // Clean up regardless of error callback success
                            delete outTbl[transId];
                            delete s_transIds[transId];
                        }
                    }
                }, timeout);
            };

            // Internal message handler for routing based on cfg
            var onMessage = function (origin, methodFromHandler, message) {
                if (typeof cfg.gotMessageObserver === 'function') { /* ... */ }
                var currentMethodName = methodFromHandler;

                if (message.id && currentMethodName) { // Request
                    if (regTbl[currentMethodName]) {
                        var trans = createTransaction(message.id, origin, message.callbacks ? message.callbacks : []);
                        inTbl[message.id] = { callbacks: message.callbacks };
                        try {
                            var resp = regTbl[currentMethodName](trans, message.params); // This calls the user's bound function
                            // If the bound function (e.g. messageFromRN) calls trans.complete(),
                            // then trans.completed() will be true here.
                            if (!trans.delayReturn() && !trans.completed()) {
                                trans.complete(resp);
                            } else {
                                debug("Bound method '" + currentMethodName + "' already completed or delayed return. Trans state: " + trans.completed());
                            }
                        } catch (e) {
                            // This is where the "ReferenceError: Can't find variable: completed" was caught
                            if (trans && !trans.completed()) { // Ensure trans exists and not already completed
                                trans.error("runtime_error", e.toString());
                            }
                        }
                    } else {
                        debug("No handler in regTbl for request method: " + currentMethodName + " (original: " + message.method + ")");
                    }
                } else if (message.id && message.callback) {
                    debug("received callback: " + message.callback + " for transaction " + message.id);
                    if (outTbl[message.id] && outTbl[message.id].callbacks && outTbl[message.id].callbacks[message.callback]) {
                        try {
                            outTbl[message.id].callbacks[message.callback](message.params);
                        } catch (e) {
                            debug("Exception executing callback function for '" + message.callback + "': " + e);
                        }
                    } else {
                        debug("ignoring invalid callback invocation, id: " + message.id + ", callback: " + message.callback);
                    }
                }
                else if (message.id) {
                    debug("received response/error for transaction " + message.id); // Use 'message.id'
                    if (outTbl[message.id]) { // Use 'message.id'
                        // Clear any timeout
                        if (outTbl[message.id].timeoutId) {
                            window.clearTimeout(outTbl[message.id].timeoutId);
                        }
                        try {
                            if (message.error) { // Use 'message.error'
                                if (typeof outTbl[message.id].error === 'function') {
                                    outTbl[message.id].error(message.error, message.message); // Use 'message.error' and 'message.message'
                                } else {
                                    debug("No error handler for transaction " + message.id + ", error: " + message.error);
                                }
                            } else { // Success
                                if (typeof outTbl[message.id].success === 'function') {
                                    outTbl[message.id].success(message.result); // Use 'message.result'
                                } else {
                                    debug("No success handler for transaction " + message.id);
                                }
                            }
                        } catch (e) {
                            debug("Exception executing success/error handler for transaction " + message.id + ": " + e);
                        } finally {
                            delete outTbl[message.id];
                            delete s_transIds[message.id]; // s_transIds keys are numbers (transaction IDs), message.id is correct here.
                        }
                    } else {
                        debug("ignoring response for unknown/completed transaction: " + message.id);
                    }
                }
                else if (currentMethodName) { // Notification
                    if (regTbl[currentMethodName]) {
                        try {
                            regTbl[currentMethodName]({ origin: origin, id: message.id }, message.params);
                        } catch (e) {
                            debug("Exception executing notification handler '" + currentMethodName + "': " + e);
                        }
                    } else {
                        debug("No handler in regTbl for notification method: " + currentMethodName + " (original: " + message.method + ")");
                    }
                } else { /* ... */ }
            };

            s_addBoundChan(cfg.window, cfg.origin, scope, onMessage);

            var scopeMethod = function (m) {
                if (m === '__ready') return m;
                if (scope && scope.length) return scope + "::" + m;
                return m;
            };

            // Post message wrapper
            var postMessage = function (msg, force) {
                if (!msg) throw "postMessage called with null message";
                var msgString = JSON.stringify(msg); // Stringify once

                var verb = (ready ? "post  " : "queue ");
                debug(verb + " message: " + msgString + (force ? " (forced)" : ""));

                if (!force && !ready) {
                    pendingQueue.push(msg); // Push the object, not the string
                } else {
                    // Observer hook
                    if (typeof cfg.postMessageObserver === 'function') {
                        try {
                            cfg.postMessageObserver(cfg.origin, JSON.parse(msgString)); // Pass parsed clone
                        } catch (e) {
                            debug("postMessageObserver() raised an exception: " + e.toString());
                        }
                    }

                    // Post using the correct method for the environment
                    if (isReactNativeWebView) {
                        cfg.window.postMessage(msgString);
                    } else {
                        cfg.window.postMessage(msgString, cfg.origin);
                    }
                }
            };

            // Ready state handler
            var onReady = function (notification_data, params) {
                var type = params;
                if (ready) {
                    // If it's a ping, we can just pong back maybe?
                    if (type === 'ping') {
                        obj.notify({ method: '__ready', params: 'pong' });
                    }
                    return;
                }
                if (type === 'ping') chanId += '-R'; else chanId += '-L';
                debug('Channel determined role: ' + chanId);
                ready = true;
                debug('Channel ready.');

                // If we received a 'ping', send back a 'pong'
                if (type === 'ping') {
                    obj.notify({ method: '__ready', params: 'pong' });
                }

                // Flush the pending queue
                debug("Flushing " + pendingQueue.length + " queued messages.");
                while (pendingQueue.length > 0) postMessage(pendingQueue.shift(), true);
                if (typeof cfg.onReady === 'function') {
                    try { cfg.onReady(obj); } catch (e) { debug("Exception in onReady callback: " + e); }
                }
            };

            // Public channel object
            var obj = {
                unbind: function (method) {
                    var methodKey = method; // Use the raw (base) method name
                    if (regTbl[methodKey]) {
                        delete regTbl[methodKey];
                        debug("Unbound method: '" + methodKey + "' (from instance scope: '" + scope + "')");
                        return true;
                    }
                    return false;
                },
                bind: function (method, cb) {
                    if (!method || typeof method !== 'string') throw "'method' argument to bind must be string";
                    if (!cb || typeof cb !== 'function') throw "callback missing from bind params";

                    var methodKey = method; // Use the raw (base) method name as the key for regTbl

                    if (regTbl[methodKey]) {
                        // It's good to also check against the fully qualified scoped name if you want to be super strict
                        // to prevent binding 'foo' in scope 'A' if 'A::foo' effectively means the same method slot.
                        // However, for simplicity and directness with how s_onMessage dispatches, using methodKey is the primary fix.
                        throw "Method '" + methodKey + "' is already bound for this channel instance (scope: '" + scope + "')!";
                    }
                    regTbl[methodKey] = cb;
                    // The debug log can still show how it will be called externally
                    debug("Bound method: '" + methodKey + "' (instance scope: '" + scope + "', full name: '" + scopeMethod(method) + "')");
                    return this; // Allow chaining
                },
                call: function (m_arg) { // Changed parameter name to m_arg for clarity
                    debug("[WebView obj.call DEBUG '" + chanId + "'] ENTERED. Received 'm_arg':" + JSON.stringify(m_arg, function(key, value) { if (typeof value === 'function') { return 'function';} return value; }));

                    if (!m_arg) throw 'missing arguments to call function';
                    
                    if (!m_arg.method || typeof m_arg.method !== 'string') {
                        throw "'method' argument to call must be string";
                    }
                    if (!m_arg.success || typeof m_arg.success !== 'function') throw "'success' callback missing from call";
                    if (m_arg.error && typeof m_arg.error !== 'function') throw "'error' callback must be a function if provided";
                    var callbacks = {};
                    var callbackNames = [];
                    var seen = [];
                    var pruneFunctions = function (path, currentParam) {
                        if (currentParam === null || typeof currentParam !== 'object') return;
                        if (seen.indexOf(currentParam) >= 0) {
                            throw "params cannot be a recursive data structure containing functions";
                        }
                        seen.push(currentParam);
                        for (var k in currentParam) {
                            if (!currentParam.hasOwnProperty(k)) continue;
                            var child = currentParam[k];
                            var np = path + (path.length ? '/' : '') + k;
                            if (typeof child === 'function') {
                                callbacks[np] = child; // Store the function
                                callbackNames.push(np); // Store the path
                                // Do NOT delete the function from the original params object
                                // The remote side might need the structure. We send names separately.
                                // delete currentParam[k]; // This was the original behavior, potentially problematic.
                            } else if (typeof child === 'object') {
                                pruneFunctions(np, child); // Recurse
                            }
                        }
                        // Remove from seen list after processing children
                        seen.pop();
                    };
                    var paramsClone = m_arg.params ? JSON.parse(JSON.stringify(m_arg.params)) : undefined;
                    if (m_arg.params) { // Ensure this uses m_arg.params
                        pruneFunctions("", m_arg.params);
                    }
                    // ***************************************************************************

                    // Clone params to avoid modifying the caller's object, then prune.
                    // Deep clone is safer but complex; shallow might suffice if functions aren't nested deeply.
                    // Using JSON parse/stringify for a simple deep clone (loses functions, Dates, etc. - but we handle functions separately)
                    var paramsClone = m_arg.params ? JSON.parse(JSON.stringify(m_arg.params)) : undefined;
                    // Re-run pruneFunctions on the original m.params just to get the callback names/functions
                    // but don't modify m.params itself.
                    // Build request message
                    var currentId = s_curTranId++;
                    var scopedMethod = scopeMethod(m_arg.method); // Use m_arg.method

                    var msg = { id: currentId, method: scopedMethod, params: paramsClone }; // Now paramsClone should be defined

                    if (callbackNames.length) msg.callbacks = callbackNames;

                    // Store transaction details
                    outTbl[currentId] = {
                        callbacks: callbacks,
                        error: m_arg.error,     // Use m_arg
                        success: m_arg.success, // Use m_arg
                        timeoutId: m_arg.timeout ? setTransactionTimeout(currentId, m_arg.timeout, scopedMethod) : null // Use m_arg
                    };

                    s_transIds[currentId] = onMessage; // The instance's onMessage

                    debug("calling method '" + scopedMethod + "' with id " + currentId + ". Message being sent: " + JSON.stringify(msg).substring(0,100));
                    // For calls from WebView to RN, ready state is less critical for the initial post,
                    // as RN side will queue if its channel isn't ready.
                    // The 'isReactNativeWebView' flag is more relevant here.
                    postMessage(msg, isReactNativeWebView); // Force post if RNWebView, or rely on 'ready' for browser contexts
                    return this;
                },
                notify: function (m) {
                    if (!m) throw 'missing arguments to notify function';
                    if (!m.method || typeof m.method !== 'string') throw "'method' argument to notify must be string";

                    var scopedMethod = scopeMethod(m.method);
                    debug("sending notification: " + scopedMethod);
                    // Clone params to avoid modification issues
                    var paramsClone = m.params ? JSON.parse(JSON.stringify(m.params)) : undefined;
                    postMessage({ method: scopedMethod, params: paramsClone }, isReactNativeWebView); // Force post in RN
                },
                destroy: function () {
                    debug("Destroying channel: " + chanId);
                    s_removeBoundChan(cfg.window, cfg.origin, scope);

                    // Remove global listener only if no other channels depend on it?
                    // Hard to track safely, maybe better to leave the listener.
                    // If this is the *only* channel, could remove:
                    // if (window.removeEventListener) window.removeEventListener('message', s_onMessage, false);
                    // else if(window.detachEvent) window.detachEvent('onmessage', s_onMessage);

                    // Clear internal state
                    ready = false;
                    regTbl = {};
                    inTbl = {};
                    // Cancel any pending outbound timeouts and clear handlers
                    for (var id in outTbl) {
                        if (outTbl.hasOwnProperty(id)) {
                            if (outTbl[id].timeoutId) {
                                window.clearTimeout(outTbl[id].timeoutId);
                            }
                            delete s_transIds[id]; // Remove from global handler map too
                        }
                    }
                    outTbl = {};
                    cfg.origin = null; // Prevent further use
                    pendingQueue = [];
                    chanId = ""; // Clear ID
                }
            };

            // Bind the internal ready handler
            obj.bind('__ready', onReady);

            // Initiate the ready handshake immediately after build.
            // Use setTimeout to ensure the current execution context completes.
            // Force post in RNWebView context.
            window.setTimeout(function () {
                obj.notify({ method: '__ready', params: "ping" });
            }, 100);
            return obj;
        } // End of build function
    }; // End of return object
})(); // End of IIFE

// Add export for environments that support it (like Node.js or bundlers)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Channel;
}