/* ======================================================================
   CinemaFX — panel controller (CEP / JS side)
   Sends all enabled effect settings to ExtendScript in ONE call.
   ====================================================================== */

(function () {
    "use strict";

    var cs = new CSInterface();

    /* ------------------------------------------------------------------
       Effect model. Slider values are mapped onto Premiere GPU effects
       inside jsx/hostscript.jsx (QE DOM, batched, single undo group).
       ------------------------------------------------------------------ */
    var EFFECTS = ["grain", "bloom", "halation"];

    var state = {
        grain:    { enabled: false, intensity: 50, size: 50, opacity: 60 },
        bloom:    { enabled: false, intensity: 55, size: 45, opacity: 50 },
        halation: { enabled: false, intensity: 50, size: 50, opacity: 55 }
    };

    /* -------------------------- helpers --------------------------- */

    function $(id) { return document.getElementById(id); }

    function clampInt(value, fallback) {
        var n = parseInt(value, 10);
        if (isNaN(n)) { n = fallback; }
        if (n < 0) { n = 0; }
        if (n > 100) { n = 100; }
        return n;
    }

    function setStatus(message, kind) {
        var el = $("status-text");
        el.textContent = message;
        el.className = (kind === "error") ? "error" : (kind === "ok" ? "ok" : "");
    }

    function escapeJsString(s) {
        return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    }

    /* ---------------------- UI synchronization -------------------- */

    function syncSliderFill(slider) {
        var min = parseFloat(slider.min) || 0;
        var max = parseFloat(slider.max) || 100;
        var pct = ((parseFloat(slider.value) - min) / (max - min)) * 100;
        slider.style.setProperty("--fill", pct + "%");
    }

    function syncEffectUI(effectName) {
        var s = state[effectName];
        var card = $("card-" + effectName);
        var toggle = $(effectName + "-toggle");

        toggle.checked = s.enabled;
        card.classList.toggle("on", s.enabled);
        card.classList.toggle("expanded", s.enabled);

        ["intensity", "size", "opacity"].forEach(function (key) {
            var slider = $(effectName + "-" + key);
            var readout = $(effectName + "-" + key + "-value");
            slider.value = s[key];
            readout.textContent = s[key];
            syncSliderFill(slider);

            /* CEP's Chromium is older than the spec for `.disabled` on
               range inputs in some builds, so set the attribute directly. */
            if (s.enabled) {
                slider.removeAttribute("disabled");
                slider.setAttribute("aria-disabled", "false");
            } else {
                slider.setAttribute("disabled", "disabled");
                slider.setAttribute("aria-disabled", "true");
            }
            slider.closest(".param-row").classList.toggle("disabled", !s.enabled);
        });
    }

    function syncAllUI() {
        EFFECTS.forEach(syncEffectUI);
    }

    /* -------------------------- persistence ----------------------- */

    var STORAGE_KEY = "cinemafx.state.v1";

    function saveState() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }

    function loadState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) { return; }
            var stored = JSON.parse(raw);
            EFFECTS.forEach(function (name) {
                if (stored && stored[name]) {
                    state[name].enabled = !!stored[name].enabled;
                    state[name].intensity = clampInt(stored[name].intensity, state[name].intensity);
                    state[name].size = clampInt(stored[name].size, state[name].size);
                    state[name].opacity = clampInt(stored[name].opacity, state[name].opacity);
                }
            });
        } catch (e) { /* ignore corrupt state */ }
    }

    /* -------------------------- events ---------------------------- */

    function wireEvents() {
        EFFECTS.forEach(function (name) {
            var toggle = $(name + "-toggle");
            var card = $("card-" + name);
            var header = $(name + "-header");
            var switchEl = header.querySelector(".switch");

            /* A click on the switch bubbles twice (label click + the
               synthesized input click), so stop it at the label —
               otherwise one click both toggles AND collapses the card. */
            if (switchEl) {
                switchEl.addEventListener("click", function (event) {
                    event.stopPropagation();
                });
            }

            toggle.addEventListener("change", function () {
                state[name].enabled = toggle.checked;
                saveState();
                syncEffectUI(name);
            });

            header.addEventListener("click", function (event) {
                /* Collapse/expand on header click — except on the switch,
                   which manages its own behavior above. */
                if (event.target.closest(".switch")) { return; }
                card.classList.toggle("expanded");
            });

            header.addEventListener("keydown", function (event) {
                if (event.key === "Enter" || event.key === " ") {
                    card.classList.toggle("expanded");
                }
            });

            ["intensity", "size", "opacity"].forEach(function (key) {
                var slider = $(name + "-" + key);
                slider.addEventListener("input", function () {
                    state[name][key] = clampInt(slider.value, 50);
                    $(name + "-" + key + "-value").textContent = state[name][key];
                    syncSliderFill(slider);
                    saveState();
                });
            });
        });

        $("apply-btn").addEventListener("click", onApply);
    }

    /* ----------------------- host communication ------------------- */

    function buildPayload() {
        /* Compact delimited payload (ExtendScript has no native JSON):
           v|grain:on,int,size,opacity|bloom:...|halation:... */
        var parts = ["1"];
        EFFECTS.forEach(function (name) {
            var s = state[name];
            parts.push(name + ":" +
                (s.enabled ? "1" : "0") + "," +
                clampInt(s.intensity, 50) + "," +
                clampInt(s.size, 50) + "," +
                clampInt(s.opacity, 50));
        });
        return parts.join("|");
    }

    function onApply() {
        var anyEnabled = EFFECTS.some(function (n) { return state[n].enabled; });
        if (!anyEnabled) {
            setStatus("Nothing to apply — enable at least one effect first.", "error");
            return;
        }

        var btn = $("apply-btn");
        btn.setAttribute("disabled", "disabled");
        setStatus("Applying effects…", "");

        var payload = buildPayload();
        cs.evalScript("cinemaFX_apply('" + payload.replace(/'/g, "") + "')", onHostResult);
    }

    function onHostResult(result) {
        $("apply-btn").removeAttribute("disabled");

        if (result === EvalScript_ErrMessage.ERR) {
            setStatus("Could not reach the ExtendScript host. Reopen the panel and try again.", "error");
            return;
        }

        result = String(result || "");
        if (result.indexOf("ERR:") === 0) {
            setStatus(result.substring(4), "error");
        } else if (result.indexOf("OK:") === 0) {
            setStatus(result.substring(3), "ok");
        } else {
            setStatus("Unexpected host response.", "error");
        }
    }

    /* Ensure the host script is present even if CSXS did not pre-load it. */
    function ensureHostScript(callback) {
        cs.evalScript("typeof cinemaFX_apply", function (result) {
            if (String(result) === "function") { callback(); return; }
            var extRoot = cs.getSystemPath(SystemPath.EXTENSION);
            if (!extRoot) { callback(); return; }
            var jsxPath = extRoot + "/jsx/hostscript.jsx";
            cs.evalScript(
                "$.evalFile('" + escapeJsString(jsxPath) + "'); typeof cinemaFX_apply;",
                function (after) {
                    if (String(after) !== "function") {
                        setStatus("Host script failed to load. Check the extension folder.", "error");
                        return;
                    }
                    callback();
                }
            );
        });
    }

    /* --------------------------- init ----------------------------- */

    function init() {
        loadState();
        syncAllUI();
        wireEvents();
        ensureHostScript(function () {
            setStatus("Ready. Select clips in the timeline, then apply.", "");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
