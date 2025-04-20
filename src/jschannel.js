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
        try {
            var m = JSON.parse(e.data);
            if (typeof m !== 'object' || m === null) throw "malformed";
        } catch (err) {
            // Ignore non-JSON messages
            // console.debug("jschannel: received non-JSON message: ", e.data);
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
            if (ar.length == 2) {
                s = ar[0];
                meth = ar[1];
            } else {
                // If no scope prefix is found, assume default scope (empty string)
                s = '';
                meth = m.method;
            }
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
            var debug = function (m) {
                if (cfg.debugOutput && window.console && window.console.log) {
                    try { if (typeof m !== 'string') m = JSON.stringify(m); } catch (e) { /* ignore */ }
                    console.log("[" + chanId + "] " + m);
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


            // Validate origin
            var validOrigin = false;
            if (typeof cfg.origin === 'string') {
                if (cfg.origin === "*") {
                    validOrigin = true;
                } else if (isReactNativeWebView && cfg.origin === 'react-native-webview') {
                    console.warn("jschannel: 'react-native-webview' origin is deprecated, prefer '*'.");
                    validOrigin = true; // Allow for backward compatibility but warn
                } else {
                    var oMatch = cfg.origin.match(/^https?:\/\/(?:[-a-zA-Z0-9_\.])+(?::\d+)?/);
                    if (oMatch !== null) {
                        cfg.origin = oMatch[0].toLowerCase();
                        validOrigin = true;
                    }
                }
            }

            if (!validOrigin) throw ("Channel.build() called with an invalid origin: " + cfg.origin);

            // Validate scope
            var scope = ''; // Default scope is empty string
            if (typeof cfg.scope !== 'undefined') {
                if (typeof cfg.scope !== 'string') throw 'scope, when specified, must be a string';
                if (cfg.scope.split('::').length > 1) throw "scope may not contain double colons: '::'";
                scope = cfg.scope; // Use provided scope
            }

            /* Private variables */
            var chanId = (function () {
                var text = "";
                var alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                for (var i = 0; i < 5; i++) text += alpha.charAt(Math.floor(Math.random() * alpha.length));
                return text;
            })();

            var regTbl = {};      // Method registry
            var outTbl = {};      // Outbound transactions
            var inTbl = {};       // Inbound transactions
            var ready = false;     // Channel ready state
            var pendingQueue = [];// Queue for messages before ready

            // Transaction creation logic
            var createTransaction = function (id, origin, callbacks) {
                var shouldDelayReturn = false;
                var completed = false;
                var localDebug = function (m) { debug("transaction(" + id + "): " + m); };

                return {
                    origin: origin,
                    invoke: function (cbName, v) {
                        if (completed) { localDebug("Warning: invoke called after completion"); return; }
                        if (!inTbl[id]) { localDebug("Warning: invoke called for nonexistent transaction"); return; } // Changed from throw to warn

                        var valid = false;
                        for (var i = 0; i < callbacks.length; i++) if (cbName === callbacks[i]) { valid = true; break; }
                        if (!valid) throw "Request supports no such callback '" + cbName + "'";

                        localDebug("sending callback '" + cbName + "'");
                        postMessage({ id: id, callback: cbName, params: v }, isReactNativeWebView); // Force post in RN
                    },
                    error: function (error, message) {
                        if (completed) { localDebug("Warning: error called after completion"); return; }
                        completed = true;
                        if (!inTbl[id]) { localDebug("Warning: error called for nonexistent transaction"); return; } // Changed from throw to warn

                        delete inTbl[id];
                        // Don't delete from s_transIds here, that's for outbound calls
                        localDebug("sending error: " + error + " / " + message);
                        postMessage({ id: id, error: error, message: message }, isReactNativeWebView); // Force post in RN
                    },
                    complete: function (v) {
                        if (completed) { localDebug("Warning: complete called after completion"); return; }
                        completed = true;
                        if (!inTbl[id]) { localDebug("Warning: complete called for nonexistent transaction"); return; } // Changed from throw to warn

                        delete inTbl[id];
                        // Don't delete from s_transIds here
                        localDebug("sending complete");
                        postMessage({ id: id, result: v }, isReactNativeWebView); // Force post in RN
                    },
                    delayReturn: function (delay) {
                        if (typeof delay === 'boolean') {
                            shouldDelayReturn = (delay === true);
                        }
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
            var onMessage = function (origin, method, m) {
                // Observer hook
                if (typeof cfg.gotMessageObserver === 'function') {
                    try {
                        // Provide a clone to prevent observer mutation affecting logic
                        cfg.gotMessageObserver(origin, JSON.parse(JSON.stringify(m)));
                    } catch (e) {
                        debug("gotMessageObserver() raised an exception: " + e.toString());
                    }
                }

                // Message routing logic
                if (m.id && method) {
                    // Request
                    debug("received request: " + method + "() from " + origin + " (id: " + m.id + ")");
                    if (regTbl[method]) {
                        var trans = createTransaction(m.id, origin, m.callbacks ? m.callbacks : []);
                        inTbl[m.id] = { callbacks: m.callbacks }; // Store info about the inbound transaction
                        try {
                            // Setup callbacks in params object if needed
                            if (m.callbacks && s_isArray(m.callbacks) && m.callbacks.length > 0) {
                                for (var i = 0; i < m.callbacks.length; i++) {
                                    var path = m.callbacks[i];
                                    var obj = m.params || {}; // Ensure params exists
                                    var pathItems = path.split('/');
                                    var currentObj = obj;
                                    for (var j = 0; j < pathItems.length - 1; j++) {
                                        var cp = pathItems[j];
                                        if (typeof currentObj[cp] !== 'object' || currentObj[cp] === null) currentObj[cp] = {};
                                        currentObj = currentObj[cp];
                                    }
                                    // Assign the function to the final path item
                                    currentObj[pathItems[pathItems.length - 1]] = (function (cbName) {
                                        return function (params) {
                                            // Use the captured cbName
                                            return trans.invoke(cbName, params);
                                        };
                                    })(path); // Immediately invoke to capture 'path'
                                }
                            }

                            var resp = regTbl[method](trans, m.params);
                            if (!trans.delayReturn() && !trans.completed()) {
                                trans.complete(resp);
                            }
                        } catch (e) {
                            debug("Exception executing bound method '" + method + "': " + e.toString());
                            var error = "runtime_error";
                            var message = e.toString();
                            if (typeof e === 'string') {
                                message = e;
                            } else if (typeof e === 'object' && e !== null) {
                                if (s_isArray(e) && e.length == 2 && typeof e[0] === 'string') {
                                    error = e[0];
                                    message = e[1];
                                } else if (typeof e.error === 'string') {
                                    error = e.error;
                                    message = (typeof e.message === 'string') ? e.message : JSON.stringify(e.message);
                                } else {
                                    try { message = JSON.stringify(e); } catch (e2) { /* use toString */ }
                                }
                            }
                            // Ensure transaction wasn't already completed by the exception handler
                            if (!trans.completed()) {
                                trans.error(error, message);
                            }
                        }
                    } else {
                        debug("No handler registered for method: " + method);
                        // Optionally send a method_not_found error back
                        // createTransaction(m.id, origin, []).error("method_not_found", "Method '" + method + "' is not bound.");
                    }
                } else if (m.id && m.callback) {
                    // Callback invocation
                    debug("received callback: " + m.callback + " for transaction " + m.id);
                    if (outTbl[m.id] && outTbl[m.id].callbacks && outTbl[m.id].callbacks[m.callback]) {
                        try {
                            outTbl[m.id].callbacks[m.callback](m.params);
                        } catch (e) {
                            debug("Exception executing callback function for '" + m.callback + "': " + e);
                            // Maybe call the main error handler? Depends on desired behavior.
                            // if (typeof outTbl[m.id].error === 'function') {
                            //     outTbl[m.id].error("callback_execution_error", "Exception in callback '" + m.callback + "': " + e.toString());
                            //     delete outTbl[m.id];
                            //     delete s_transIds[m.id];
                            // }
                        }
                    } else {
                        debug("ignoring invalid callback invocation, id: " + m.id + ", callback: " + m.callback);
                    }
                } else if (m.id) {
                    // Response or Error
                    debug("received response/error for transaction " + m.id);
                    if (outTbl[m.id]) {
                        // Clear any timeout associated with this transaction
                        if (outTbl[m.id].timeoutId) {
                            window.clearTimeout(outTbl[m.id].timeoutId);
                        }
                        try {
                            if (m.error) {
                                if (typeof outTbl[m.id].error === 'function') {
                                    outTbl[m.id].error(m.error, m.message);
                                } else {
                                    debug("No error handler for transaction " + m.id + ", error: " + m.error);
                                }
                            } else {
                                if (typeof outTbl[m.id].success === 'function') {
                                    // Provide result or undefined if not present
                                    outTbl[m.id].success(m.result);
                                } else {
                                    debug("No success handler for transaction " + m.id);
                                }
                            }
                        } catch (e) {
                            debug("Exception executing success/error handler for transaction " + m.id + ": " + e);
                        } finally {
                            // Clean up state regardless of handler success/failure
                            delete outTbl[m.id];
                            delete s_transIds[m.id];
                        }
                    } else {
                        debug("ignoring response for unknown/completed transaction: " + m.id);
                    }
                } else if (method) {
                    // Notification
                    debug("received notification: " + method + "() from " + origin);
                    if (regTbl[method]) {
                        try {
                            // Notifications have no transaction object, just pass origin and params
                            regTbl[method]({ origin: origin }, m.params);
                        } catch (e) {
                            debug("Exception executing notification handler '" + method + "': " + e);
                            // Cannot send error back for notification
                        }
                    } else {
                        debug("No handler registered for notification: " + method);
                    }
                } else {
                    debug("Received message that is not a request, response, or notification: " + JSON.stringify(m));
                }
            };

            // Register this channel instance in the global routing table
            s_addBoundChan(cfg.window, cfg.origin, scope, onMessage);

            // Method scoping helper
            var scopeMethod = function (m) {
                if (scope && scope.length) {
                    // Ensure method name doesn't already have a scope conflict? No, allow it.
                    return scope + "::" + m;
                }
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
            var onReady = function (trans, type) {
                debug('Received __ready message type: ' + type);
                if (ready) {
                    debug("Warning: received ready message while already in ready state.");
                    // If it's a ping, we can just pong back maybe?
                    if (type === 'ping') {
                        obj.notify({ method: '__ready', params: 'pong' });
                    }
                    return; // Don't re-initialize
                }

                // Assign Left/Right role based on first message received.
                // This helps debugging but isn't essential for function.
                if (type === 'ping') {
                    chanId += '-R'; // Received Ping first, we are Right/Responder
                } else { // type === 'pong'
                    chanId += '-L'; // Received Pong first, we are Left/Initiator
                }
                debug('Channel determined role: ' + chanId);

                obj.unbind('__ready'); // Unbind the ready handler itself
                ready = true;
                debug('Channel ready.');

                // If we received a 'ping', send back a 'pong'
                if (type === 'ping') {
                    obj.notify({ method: '__ready', params: 'pong' });
                }

                // Flush the pending queue
                debug("Flushing " + pendingQueue.length + " queued messages.");
                while (pendingQueue.length > 0) {
                    // Dequeue from front, post immediately (force=true)
                    postMessage(pendingQueue.shift(), true);
                }

                // Invoke the external onReady callback
                if (typeof cfg.onReady === 'function') {
                    try {
                        cfg.onReady(obj); // Pass the channel object itself
                    } catch (e) {
                        debug("Exception in onReady callback: " + e);
                    }
                }
            };

            // Public channel object
            var obj = {
                unbind: function (method) {
                    var scopedMethod = scopeMethod(method);
                    if (regTbl[scopedMethod]) {
                        delete regTbl[scopedMethod];
                        debug("Unbound method: " + scopedMethod);
                        return true;
                    }
                    return false;
                },
                bind: function (method, cb) {
                    if (!method || typeof method !== 'string') throw "'method' argument to bind must be string";
                    if (!cb || typeof cb !== 'function') throw "callback missing from bind params";

                    var scopedMethod = scopeMethod(method);
                    if (regTbl[scopedMethod]) throw "Method '" + scopedMethod + "' is already bound!";
                    regTbl[scopedMethod] = cb;
                    debug("Bound method: " + scopedMethod);
                    return this; // Allow chaining
                },
                call: function (m) {
                    if (!m) throw 'missing arguments to call function';
                    if (!m.method || typeof m.method !== 'string') throw "'method' argument to call must be string";
                    if (!m.success || typeof m.success !== 'function') throw "'success' callback missing from call";
                    // m.error is optional, but should be a function if provided
                    if (m.error && typeof m.error !== 'function') throw "'error' callback must be a function if provided";


                    var callbacks = {};
                    var callbackNames = [];
                    var seen = []; // For recursion detection

                    // Recursively find functions in params and replace them with placeholders
                    var pruneFunctions = function (path, currentParam) {
                        if (currentParam === null || typeof currentParam !== 'object') return; // Only traverse objects/arrays

                        if (seen.indexOf(currentParam) >= 0) {
                            throw "params cannot be a recursive data structure containing functions";
                        }
                        seen.push(currentParam);

                        for (var k in currentParam) {
                            if (!currentParam.hasOwnProperty(k)) continue;
                            var child = currentParam[k];
                            var np = path + (path.length ? '/' : '') + k; // Build path string

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


                    // Clone params to avoid modifying the caller's object, then prune.
                    // Deep clone is safer but complex; shallow might suffice if functions aren't nested deeply.
                    // Using JSON parse/stringify for a simple deep clone (loses functions, Dates, etc. - but we handle functions separately)
                    var paramsClone = m.params ? JSON.parse(JSON.stringify(m.params)) : undefined;
                    // Re-run pruneFunctions on the original m.params just to get the callback names/functions
                    // but don't modify m.params itself.
                    pruneFunctions("", m.params);


                    // Build request message
                    var currentId = s_curTranId++;
                    var scopedMethod = scopeMethod(m.method);
                    var msg = { id: currentId, method: scopedMethod, params: paramsClone }; // Send the cloned params
                    if (callbackNames.length) msg.callbacks = callbackNames;


                    // Store transaction details
                    outTbl[currentId] = {
                        callbacks: callbacks, // The actual functions
                        error: m.error,       // Error handler
                        success: m.success,   // Success handler
                        // Store timeoutId if timeout is set
                        timeoutId: m.timeout ? setTransactionTimeout(currentId, m.timeout, scopedMethod) : null
                    };

                    // Map transaction ID to the internal message handler
                    s_transIds[currentId] = onMessage;


                    debug("calling method '" + scopedMethod + "' with id " + currentId);
                    // Post the message. Use 'force' in RNWebView context as ready state might be ambiguous.
                    postMessage(msg, isReactNativeWebView);
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
            debug("Initiating ready handshake (sending ping)");
            window.setTimeout(function () {
                postMessage({ method: scopeMethod('__ready'), params: "ping" }, isReactNativeWebView);
            }, 0);

            return obj;
        } // End of build function
    }; // End of return object
})(); // End of IIFE

// Add export for environments that support it (like Node.js or bundlers)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Channel;
}