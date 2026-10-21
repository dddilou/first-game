/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
    const withIsolationHeaders = (headers = new Headers()) => {
        const newHeaders = new Headers(headers);
        newHeaders.set("Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp"
        );
        if (!coepCredentialless) {
            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
        }
        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
        return newHeaders;
    };

    const fetchSplitWasm = async () => {
        const partNames = [
            "FirstGame.wasm.part0",
            "FirstGame.wasm.part1",
            "FirstGame.wasm.part2",
            "FirstGame.wasm.part3",
            "FirstGame.wasm.part4",
        ];
        const responses = await Promise.all(partNames.map((name) => fetch(name)));
        if (responses.some((response) => !response.ok)) {
            throw new Error("Unable to download all WebAssembly parts.");
        }
        const buffers = await Promise.all(responses.map((response) => response.arrayBuffer()));
        const totalLength = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const buffer of buffers) {
            merged.set(new Uint8Array(buffer), offset);
            offset += buffer.byteLength;
        }
        const headers = withIsolationHeaders({
            "Content-Type": "application/wasm",
            "Content-Length": String(totalLength),
        });
        return new Response(merged, { status: 200, headers });
    };

    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        if (new URL(r.url).pathname.endsWith("/FirstGame.wasm")) {
            event.respondWith(fetchSplitWasm().catch((e) => {
                console.error(e);
                return new Response("Unable to load game engine.", {
                    status: 500,
                    headers: withIsolationHeaders({ "Content-Type": "text/plain" }),
                });
            }));
            return;
        }

        // Let Godot's JavaScript, worker, pack, audio and image files load
        // directly from the host. Intercepting those responses can make
        // WorkerGlobalScope.importScripts() reject FirstGame.js on Vercel.
        // Navigation responses are the only other responses that need
        // isolation headers for hosts such as GitHub Pages.
        if (r.mode !== "navigate") {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    // Vercel already adds these headers through vercel.json.
                    // Keep its original response intact so Web Worker
                    // importScripts() can load FirstGame.js normally.
                    if (
                        response.headers.has("Cross-Origin-Embedder-Policy") &&
                        response.headers.has("Cross-Origin-Opener-Policy")
                    ) {
                        return response;
                    }

                    const newHeaders = withIsolationHeaders(response.headers);

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const controlling = n.serviceWorker && n.serviceWorker.controller;

        // Record the failure if the page is served by serviceWorker.
        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

        if (controlling) {
            // Reload only on the first failure.
            const reloadToDegrade = coi.coepDegrade() && !(
                coepDegrading || window.crossOriginIsolated
            );
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || coepHasFailed && coi.coepDegrade())
                    ? false
                    : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                !coi.quiet && console.log("Reloading page to degrade COEP.");
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // Always register this worker when needed. Besides adding COOP/COEP headers,
        // it rebuilds FirstGame.wasm from the split files used by browser uploads.
        // Vercel already supplies isolation headers, but the worker is still needed
        // to serve the reconstructed WebAssembly file.
        if (!coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Firefox private mode) this won't be available
        if (!n.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                // On a first visit, wait until the worker is active before reloading.
                // Reloading as soon as `updatefound` fires is too early: Godot would
                // request FirstGame.wasm before the worker could rebuild it.
                if (!n.serviceWorker.controller) {
                    n.serviceWorker.ready.then(() => {
                        !coi.quiet && console.log("Reloading page to use the split-WASM Service Worker.");
                        window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                        coi.doReload();
                    });
                }
            },
            (err) => {
                !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
            }
        );
    })();
}

