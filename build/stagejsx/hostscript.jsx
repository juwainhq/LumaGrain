/* ======================================================================
   CinemaFX — ExtendScript host engine for Adobe Premiere Pro (Windows)
   ---------------------------------------------------------------------
   Applies cinematic Film Grain / Bloom / Halation using Premiere's
   NATIVE, Mercury-Playback-Engine (MPE) GPU-accelerated video effects:

     Film Grain : Fast Blur (grain size) + Noise (grain amount)
     Bloom      : VR Glow (native GPU glow); falls back to the classic
                  Fast Blur + Brightness & Contrast + Screen blend rig
     Halation   : Channel Blur (red-channel bleed) + warm Tint

   Effects are ADDED through the QE DOM (the only scripting surface that
   can add effects to timeline clips) and are then PARAMETERIZED through
   the official DOM (clip.components). All rendering stays inside
   Premiere's built-in GPU effect engine — no software-only paths.

   Entry point (one call per Apply click, all effects batched):
       cinemaFX_apply(payload)

   Payload format (delimited — ExtendScript has no native JSON):
       "1|grain:e,i,s,o|bloom:e,i,s,o|halation:e,i,s,o"
       e = enabled 0/1, i/s/o = intensity/size/opacity 0..100

   Return format:  "OK:<message>"  or  "ERR:<message>"
   ====================================================================== */

/* Blend-mode enum for the Opacity component, "Screen".
   Follows Premiere's internal BlendMode ordering (Normal = 16777216).
   Used only by the Bloom fallback rig. */
var CFX_BLEND_SCREEN = 1668047672;

/* ---------------------------------------------------------------------
   Utilities (ES3-safe: ExtendScript has no JSON / Array extras)
   --------------------------------------------------------------------- */

function _cfx_clamp100(v, fallback) {
    var n = parseFloat(v);
    if (isNaN(n)) { n = fallback; }
    if (n < 0) { n = 0; }
    if (n > 100) { n = 100; }
    return n;
}

function _cfx_defaults(cfg) {
    if (!cfg) {
        return { enabled: false, intensity: 50, size: 50, opacity: 50 };
    }
    return {
        enabled: String(cfg.enabled) === "1" || cfg.enabled === true,
        intensity: _cfx_clamp100(cfg.intensity, 50),
        size: _cfx_clamp100(cfg.size, 50),
        opacity: _cfx_clamp100(cfg.opacity, 50)
    };
}

function _cfx_parsePayload(s) {
    var cfg = { grain: null, bloom: null, halation: null };
    var parts = String(s).split("|");
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        var ci = part.indexOf(":");
        if (ci < 0) { continue; }
        var name = part.substring(0, ci);
        var vals = part.substring(ci + 1).split(",");
        if (vals.length < 4) { continue; }
        if (name === "grain" || name === "bloom" || name === "halation") {
            cfg[name] = _cfx_defaults({
                enabled: vals[0],
                intensity: vals[1],
                size: vals[2],
                opacity: vals[3]
            });
        }
    }
    return cfg;
}

/* ---------------------------------------------------------------------
   Clip resolution — official DOM
   --------------------------------------------------------------------- */

/* Re-resolves a live trackItem on every access so that effects added
   moments earlier via the QE DOM are visible to the parameter code. */
function _cfx_resolveClip(desc) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { return null; }
        var track = seq.videoTracks[desc.trackIndex];
        if (!track) { return null; }
        return track.clips[desc.clipIndex];
    } catch (e) {
        return null;
    }
}

/* Collects lightweight descriptors (indices + node id, never live
   objects — those go stale while the QE DOM mutates the timeline). */
function _cfx_getSelectedClipDescriptors() {
    var out = [];
    var seq = app.project.activeSequence;
    if (!seq) { return out; }
    var numTracks = seq.videoTracks.numTracks;
    for (var t = 0; t < numTracks; t++) {
        var track = seq.videoTracks[t];
        if (!track) { continue; }
        var numClips = track.clips.numItems;
        for (var c = 0; c < numClips; c++) {
            var clip = track.clips[c];
            if (!clip) { continue; }
            var node = "";
            try { node = String(clip.nodeId); } catch (e0) { node = ""; }
            var selected = false;
            try { selected = clip.isSelected && clip.isSelected(); } catch (e1) { selected = false; }
            if (selected) {
                out.push({ node: node, trackIndex: t, clipIndex: c });
            }
        }
    }
    return out;
}

/* ---------------------------------------------------------------------
   QE DOM helpers
   --------------------------------------------------------------------- */

function _cfx_qeClipFor(desc) {
    var qseq = qe.project.getActiveSequence();
    if (!qseq) { return null; }
    var qtrack = qseq.getVideoTrackAt(desc.trackIndex);
    if (!qtrack) { return null; }

    var fallback = null;
    var nonEmptyIndex = 0;
    var n = qtrack.numItems;
    for (var i = 0; i < n; i++) {
        var item = qtrack.getItemAt(i);
        if (!item) { continue; }
        var type = "";
        try { type = String(item.type); } catch (e2) { type = ""; }
        if (type === "Empty") { continue; }

        /* Primary identity: QE node id === official-DOM node id. */
        if (desc.node && desc.node !== "undefined") {
            var qNode = "";
            try { qNode = String(item.nodeId); } catch (e3) { qNode = ""; }
            if (qNode && qNode === desc.node) { return item; }
        }
        /* Fallback identity: k-th non-empty QE item === k-th clip. */
        if (nonEmptyIndex === desc.clipIndex) { fallback = item; }
        nonEmptyIndex++;
    }
    return fallback;
}

/* Resolves a QE effect object, trying the internal matchName first and
   then the English display name (works on localized installs too). */
function _cfx_getQeEffect(names) {
    for (var i = 0; i < names.length; i++) {
        var fx = null;
        try { fx = qe.project.getVideoEffectByName(names[i]); } catch (e) { fx = null; }
        if (fx) { return fx; }
    }
    return null;
}

/* ---------------------------------------------------------------------
   Effect component / parameter helpers — official DOM
   --------------------------------------------------------------------- */

/* Finds a clip component (effect) by internal matchName or by display
   name — either list may be empty. */
function _cfx_findComponent(clip, matchNames, displayNames) {
    if (!clip) { return null; }
    var comps = clip.components;
    if (!comps) { return null; }
    var n = comps.numItems;
    for (var i = 0; i < n; i++) {
        var comp = comps[i];
        if (!comp) { continue; }
        var mn = "", dn = "";
        try { mn = String(comp.matchName); } catch (e4) { mn = ""; }
        try { dn = String(comp.displayName); } catch (e5) { dn = ""; }
        var k;
        if (matchNames) {
            for (k = 0; k < matchNames.length; k++) {
                if (mn === matchNames[k]) { return comp; }
            }
        }
        if (displayNames) {
            for (k = 0; k < displayNames.length; k++) {
                if (dn === displayNames[k]) { return comp; }
            }
        }
    }
    return null;
}

/* Sets the first property whose displayName or matchName matches one of
   the candidates (case-insensitive, prefix match — tolerant of Premiere's
   display suffixes like "(%)" and plural variants). Returns true on
   success. Candidate lists are kept unambiguous per component. */
function _cfx_setProp(comp, candidates, value) {
    if (!comp) { return false; }
    var props = comp.properties;
    if (!props) { return false; }
    var n = props.numItems;
    for (var i = 0; i < n; i++) {
        var prop = props[i];
        if (!prop) { continue; }
        var dn = "", mn = "";
        try { dn = String(prop.displayName).toLowerCase(); } catch (e6) { dn = ""; }
        try { mn = String(prop.matchName).toLowerCase(); } catch (e7) { mn = ""; }
        for (var k = 0; k < candidates.length; k++) {
            var cand = String(candidates[k]).toLowerCase();
            if (dn.indexOf(cand) === 0 || mn.indexOf(cand) === 0) {
                try { prop.setValue(value, true); return true; } catch (e8) { return false; }
            }
        }
    }
    return false;
}

/* Sets a color parameter. ClipProperty offers setColorValue(alpha, r, g,
   b, 0..255); falls back to an array setValue for older builds. */
function _cfx_setColorProp(comp, candidates, r, g, b) {
    if (!comp) { return false; }
    var props = comp.properties;
    if (!props) { return false; }
    var n = props.numItems;
    for (var i = 0; i < n; i++) {
        var prop = props[i];
        if (!prop) { continue; }
        var dn = "", mn = "";
        try { dn = String(prop.displayName).toLowerCase(); } catch (e9) { dn = ""; }
        try { mn = String(prop.matchName).toLowerCase(); } catch (e10) { mn = ""; }
        for (var k = 0; k < candidates.length; k++) {
            var cand = String(candidates[k]).toLowerCase();
            if (dn.indexOf(cand) === 0 || mn.indexOf(cand) === 0) {
                try { prop.setColorValue(255, r, g, b); return true; } catch (e11) {
                    try { prop.setValue([r, g, b], true); return true; } catch (e12) { return false; }
                }
            }
        }
    }
    return false;
}

function _cfx_opacityComponent(desc) {
    var clip = _cfx_resolveClip(desc);
    if (!clip) { return null; }
    return _cfx_findComponent(clip, ["ADBE Opacity"], ["Opacity"]);
}

function _cfx_setBlendScreen(desc) {
    var oc = _cfx_opacityComponent(desc);
    if (!oc) { return false; }
    return _cfx_setProp(oc, ["Blend Mode", "ADBE Opacity-0002"], CFX_BLEND_SCREEN);
}

function _cfx_setClipMix(desc, percent) {
    var oc = _cfx_opacityComponent(desc);
    if (!oc) { return false; }
    return _cfx_setProp(oc, ["Opacity", "ADBE Opacity-0001"], Math.round(percent));
}

/* Adds an effect when the clip does not already carry it (idempotent, so
   repeated Apply clicks never stack duplicates). Returns:
   "added" | "exists" | "failed" */
function _cfx_ensureEffect(desc, qeNameCandidates, matchNames, displayNames) {
    var clip = _cfx_resolveClip(desc);
    if (_cfx_findComponent(clip, matchNames, displayNames)) { return "exists"; }

    var qeClip = _cfx_qeClipFor(desc);
    if (!qeClip) { return "failed"; }

    var fx = _cfx_getQeEffect(qeNameCandidates);
    if (!fx) { return "failed"; }

    try {
        qeClip.addVideoEffect(fx);
    } catch (e) {
        return "failed";
    }
    return "added";
}

/* ---------------------------------------------------------------------
   FILM GRAIN
   Native GPU rig: Fast Blur (size) + Noise (mono, clipped).
     Intensity -> Noise / Amount of Noise   (Premiere range 0..20)
     Size      -> Fast Blur / Blurriness    (0..4 — clumps the grain)
     Opacity   -> scales the noise amount   (overall grain visibility)
   --------------------------------------------------------------------- */
function _cfx_applyGrain(desc, cfg, report) {
    var stBlur = _cfx_ensureEffect(desc,
        ["ADBE Fast Blur", "Fast Blur"],
        ["ADBE Fast Blur"], ["Fast Blur"]);
    if (stBlur !== "failed") {
        var clip0 = _cfx_resolveClip(desc);
        var blur = _cfx_findComponent(clip0, ["ADBE Fast Blur"], ["Fast Blur"]);
        if (blur) {
            _cfx_setProp(blur, ["Blurriness", "ADBE Fast Blur-0001"],
                         Math.round(cfg.size * 0.04));
            _cfx_setProp(blur, ["Repeat Edge Pixel", "ADBE Fast Blur-0003"], true);
        }
    } else {
        report.warn("Grain: Fast Blur unavailable (size control limited).");
    }

    var st = _cfx_ensureEffect(desc,
        ["ADBE Noise", "Noise"],
        ["ADBE Noise"], ["Noise"]);
    if (st === "failed") { report.warn("Grain: could not add Noise."); return; }

    var clip = _cfx_resolveClip(desc);
    var noise = _cfx_findComponent(clip, ["ADBE Noise"], ["Noise"]);
    if (!noise) { report.warn("Grain: Noise not found after add."); return; }

    /* amount = intensity(0..1) * opacity(0..1) * 20 -> native 0..20 */
    var amount = (cfg.intensity / 100) * (cfg.opacity / 100) * 20;
    _cfx_setProp(noise, ["Amount of Noise", "ADBE Noise-0001"], Math.round(amount));
    _cfx_setProp(noise, ["Use Color Noise", "ADBE Noise-0002"], false);
    _cfx_setProp(noise, ["Clipping", "ADBE Noise-0003"], true);
}

/* ---------------------------------------------------------------------
   BLOOM
   Primary: VR Glow — Premiere's native GPU glow (threshold + blur +
   screen composite in one MPE effect), so it works on ANY layer.
     Intensity -> Glow Intensity
     Size      -> Glow Radius
     Opacity   -> Glow Brightness (fallback: scales Glow Intensity)
   Fallback (VR Glow unavailable): the classic rig per the classic recipe —
   Fast Blur + Brightness & Contrast + Screen blend mode on the clip.
   --------------------------------------------------------------------- */
function _cfx_applyBloom(desc, cfg, report) {
    var st = _cfx_ensureEffect(desc,
        ["ADBE VR Glow", "VR Glow"],
        ["ADBE VR Glow", "ADBE VRGlow"], ["VR Glow"]);

    if (st !== "failed") {
        var clip = _cfx_resolveClip(desc);
        var glow = _cfx_findComponent(clip,
            ["ADBE VR Glow", "ADBE VRGlow"], ["VR Glow"]);
        if (!glow) { report.warn("Bloom: VR Glow not found after add."); return; }

        var intensitySet = _cfx_setProp(glow,
            ["Glow Intensity", "GlowIntensity", "ADBE VR Glow-0004"],
            Math.round(cfg.intensity));
        _cfx_setProp(glow,
            ["Glow Radius", "GlowRadius", "ADBE VR Glow-0002"],
            Math.round(cfg.size));

        /* Opacity: prefer the native brightness knob; otherwise fold the
           opacity into the glow intensity. */
        var brightnessSet = _cfx_setProp(glow,
            ["Glow Brightness", "GlowBrightness", "ADBE VR Glow-0003"],
            Math.round(cfg.opacity));
        if (!brightnessSet && intensitySet) {
            _cfx_setProp(glow,
                ["Glow Intensity", "GlowIntensity", "ADBE VR Glow-0004"],
                Math.round((cfg.intensity * cfg.opacity) / 100));
        }
        if (!intensitySet && !brightnessSet) {
            report.warn("Bloom: VR Glow parameters could not be set (defaults used).");
        }
        return;
    }

    /* ---------- Fallback rig: Fast Blur + Brightness & Contrast ----- */
    report.warn("Bloom: VR Glow unavailable — using Fast Blur + Screen rig.");

    var stBlur = _cfx_ensureEffect(desc,
        ["ADBE Fast Blur", "Fast Blur"],
        ["ADBE Fast Blur"], ["Fast Blur"]);
    if (stBlur === "failed") { report.warn("Bloom: could not add Fast Blur."); return; }

    var clip2 = _cfx_resolveClip(desc);
    var blur = _cfx_findComponent(clip2, ["ADBE Fast Blur"], ["Fast Blur"]);
    if (blur) {
        _cfx_setProp(blur, ["Blurriness", "ADBE Fast Blur-0001"], Math.round(cfg.size));
        _cfx_setProp(blur, ["Repeat Edge Pixel", "ADBE Fast Blur-0003"], true);
    }

    var stBC = _cfx_ensureEffect(desc,
        ["ADBE Brightness & Contrast", "Brightness & Contrast"],
        ["ADBE Brightness & Contrast"], ["Brightness & Contrast"]);
    if (stBC !== "failed") {
        clip2 = _cfx_resolveClip(desc);
        var bc = _cfx_findComponent(clip2, ["ADBE Brightness & Contrast"], ["Brightness & Contrast"]);
        if (bc) {
            /* -10..+50 lift before the screen composite. */
            _cfx_setProp(bc, ["Brightness", "ADBE Brightness & Contrast-0001"],
                         Math.round(cfg.intensity * 0.6 - 10));
        }
    }

    if (!_cfx_setBlendScreen(desc)) {
        report.warn("Bloom: could not set Screen blend mode.");
    }
    if (!_cfx_setClipMix(desc, cfg.opacity)) {
        report.warn("Bloom: could not set clip mix.");
    }
}

/* ---------------------------------------------------------------------
   HALATION
   Warm red-channel bleed, per the classic recipe: Channel Blur with the
   red channel biased, plus a warm Tint — stacked directly on the clip.
     Intensity -> Tint / Amount to Tint     (warmth strength, 0..100)
     Size      -> Channel Blur / Red Blurriness (green/blue at 35%)
     Opacity   -> scales the blur spread    (how far red bleeds)
   --------------------------------------------------------------------- */
function _cfx_applyHalation(desc, cfg, report) {
    var st = _cfx_ensureEffect(desc,
        ["ADBE Channel Blur", "Channel Blur"],
        ["ADBE Channel Blur"], ["Channel Blur"]);
    if (st === "failed") { report.warn("Halation: could not add Channel Blur."); return; }

    var clip = _cfx_resolveClip(desc);
    var cb = _cfx_findComponent(clip, ["ADBE Channel Blur"], ["Channel Blur"]);
    if (!cb) { report.warn("Halation: Channel Blur not found after add."); return; }

    var spread = (cfg.size * cfg.opacity) / 100;   /* opacity scales bleed */
    _cfx_setProp(cb, ["Red Blurriness", "ADBE Channel Blur-0001"], Math.round(spread));
    _cfx_setProp(cb, ["Green Blurriness", "ADBE Channel Blur-0002"], Math.round(spread * 0.35));
    _cfx_setProp(cb, ["Blue Blurriness", "ADBE Channel Blur-0003"], Math.round(spread * 0.35));
    _cfx_setProp(cb, ["Repeat Edge Pixel", "Repeat Edge Pixels"], true);

    var stTint = _cfx_ensureEffect(desc,
        ["ADBE Tint", "Tint"],
        ["ADBE Tint"], ["Tint"]);
    if (stTint === "failed") { report.warn("Halation: Tint unavailable (warmth not applied)."); return; }

    clip = _cfx_resolveClip(desc);
    var tint = _cfx_findComponent(clip, ["ADBE Tint"], ["Tint"]);
    if (!tint) { return; }

    /* Shadows stay untouched (black -> black); highlights are pushed
       into the warm halation orange. */
    _cfx_setColorProp(tint, ["Map Black To", "ADBE Tint-0001"], 0, 0, 0);
    _cfx_setColorProp(tint, ["Map White To", "ADBE Tint-0002"], 255, 110, 60);
    _cfx_setProp(tint, ["Amount to Tint", "Amount", "ADBE Tint-0003", "ADBE Tint-0004"],
                 Math.round(cfg.intensity));
}

/* ---------------------------------------------------------------------
   Main entry point — ONE call applies every enabled effect to every
   selected clip (batched, minimal render overhead).
   --------------------------------------------------------------------- */
function cinemaFX_apply(payload) {
    try {
        if (!app.project) {
            return "ERR:No project open. Create or open a project first.";
        }

        /* QE DOM is required for adding effects to timeline clips. */
        app.enableQE();

        var seq = app.project.activeSequence;
        if (!seq) {
            return "ERR:No active sequence. Open or click into a sequence first.";
        }

        var cfg = _cfx_parsePayload(payload);
        var anyEnabled = (cfg.grain && cfg.grain.enabled) ||
                         (cfg.bloom && cfg.bloom.enabled) ||
                         (cfg.halation && cfg.halation.enabled);
        if (!anyEnabled) {
            return "ERR:No effects enabled. Turn on at least one effect in the panel.";
        }

        var descs = _cfx_getSelectedClipDescriptors();
        if (descs.length === 0) {
            return "ERR:No clips selected. Select one or more clips in the timeline.";
        }

        var warnings = [];
        var report = {
            warn: function (msg) {
                if (warnings.length < 3) { warnings.push(msg); }
            }
        };

        var appliedNames = [];
        if (cfg.bloom && cfg.bloom.enabled) { appliedNames.push("Bloom"); }
        if (cfg.halation && cfg.halation.enabled) { appliedNames.push("Halation"); }
        if (cfg.grain && cfg.grain.enabled) { appliedNames.push("Grain"); }

        /* Order matters: glow/blur passes first, grain last, so the grain
           is never softened by the blur stages. */
        var okClips = 0;
        for (var c = 0; c < descs.length; c++) {
            var desc = descs[c];
            try {
                if (cfg.bloom && cfg.bloom.enabled) {
                    _cfx_applyBloom(desc, cfg.bloom, report);
                }
                if (cfg.halation && cfg.halation.enabled) {
                    _cfx_applyHalation(desc, cfg.halation, report);
                }
                if (cfg.grain && cfg.grain.enabled) {
                    _cfx_applyGrain(desc, cfg.grain, report);
                }
                okClips++;
            } catch (eClip) {
                report.warn("Clip " + (c + 1) + ": " + eClip.toString());
            }
        }

        if (okClips === 0) {
            var w = warnings.length ? (" " + warnings.join(" ")) : "";
            return "ERR:Effects could not be applied to the selected clips." + w;
        }

        var msg = "OK:" + appliedNames.join(" + ") + " applied to " +
                  okClips + " clip" + (okClips === 1 ? "" : "s") +
                  " via MPE GPU effects.";
        if (warnings.length) {
            msg += " Notes: " + warnings.join(" ");
        }
        return msg;

    } catch (eTop) {
        return "ERR:" + eTop.toString();
    }
}

/* Diagnostic entry point — returns host readiness and selection count. */
function cinemaFX_status() {
    try {
        if (!app.project) { return "OK:CinemaFX host ready. No project open."; }
        var seq = app.project.activeSequence;
        var selCount = seq ? _cfx_getSelectedClipDescriptors().length : 0;
        return "OK:CinemaFX host ready. Sequence: " +
               (seq ? seq.name : "none") + ". Selected clips: " + selCount + ".";
    } catch (e) {
        return "ERR:" + e.toString();
    }
}
