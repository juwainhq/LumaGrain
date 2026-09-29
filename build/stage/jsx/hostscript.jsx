/* ======================================================================
   LumaGrain — ExtendScript host engine for Adobe Premiere Pro (Windows)
   ---------------------------------------------------------------------
   Applies cinematic Film Grain / Bloom / Halation / Low Shutter using
   Premiere's NATIVE, Mercury-Playback-Engine (MPE) GPU-accelerated
   video effects.

     Film Grain  : Fast Blur (grain size) + Noise (grain amount)
     Bloom       : VR Glow (native GPU glow); falls back to Fast Blur +
                   Brightness & Contrast + Screen blend rig
     Halation    : Channel Blur (RED ONLY) + Brightness lift + warm Tint
                   — highlights-only warm bleed, never tints shadows
     Low Shutter : Directional Blur (90°) + ghosting blur + slight
                   exposure drop — low shutter angle feel

   Toggle semantics:
     Effect ON  -> applied/updated as normal (no duplicates).
     Effect OFF -> its components are REMOVED from the clip via the QE
                   DOM (backwards index loop). Components shared with an
                   effect that is still ON are kept (Fast Blur and
                   Brightness & Contrast are used by several recipes).

   Engineering rules (all enforced below):
     1. Effects are ADDED via the QE DOM, trying name variants in
        order: "AE.ADBE X" -> "PR.ADBE X" -> "ADBE X" -> display name.
     2. Every add is VERIFIED with a QE component-count delta.
     3. Parameters are set via the official DOM (clip.components) with
        name match -> contains match -> positional index fallback.
     4. No duplicate effects: existing components are re-parameterized.
     5. Result is a JSON string:
        {success, applied[], removed[], failed[{effect, tried[]}],
         warnings[], message}

   Entry point (one call per Apply click, all effects batched):
       cinemaFX_apply(payload)

   Payload: "1|grain:e,i,s,o|bloom:e,i,s,o|halation:e,i,s,o|lowshutter:e,i,s,o"
            e = enabled 0/1, i/s/o = intensity/size/opacity 0..100
   ====================================================================== */

var CFX_BLEND_SCREEN = 1668047672; /* Opacity blend mode: Screen */
var CFX_LOG_FILE = null;

/* Shared mutable result object for the current apply run. */
var CFX_RESULT = null;

/* Effect groups used for REMOVAL matching. Fragments are matched
   case-insensitively against the QE effect name (contains).
   verifyMatchNames are the components UNIQUE to the group (shared
   ones like Fast Blur / Brightness & Contrast are excluded from
   removal verification because another ON effect may still own them). */
var CFX_GROUPS = {
    grain: {
        label: "Film Grain",
        fragments: ["Noise", "Grain"],
        verifyMatchNames: ["ADBE Noise"]
    },
    bloom: {
        label: "Bloom",
        fragments: ["Glow", "Gaussian Blur", "Fast Blur", "Brightness"],
        verifyMatchNames: ["ADBE VR Glow", "ADBE VRGlow"]
    },
    halation: {
        label: "Halation",
        fragments: ["Channel Blur", "Tint", "Brightness & Contrast"],
        verifyMatchNames: ["ADBE Channel Blur", "ADBE Tint"]
    },
    lowshutter: {
        label: "Low Shutter",
        fragments: ["Directional Blur", "Motion Blur", "Fast Blur"],
        verifyMatchNames: ["ADBE Motion Blur", "ADBE Directional Blur", "ADBE DirectionalBlur"]
    }
};

function _cfx_newResult() {
    return {
        success: true,
        applied: [],
        removed: [],
        failed: [],   /* [{effect: "Halation", tried: ["AE.ADBE Channel Blur", ...]}] */
        warnings: [],
        message: ""
    };
}

/* ---------------------------------------------------------------------
   Debug logging — one line per failed parameter write
   --------------------------------------------------------------------- */
function _cfx_log(msg) {
    try {
        if (!CFX_LOG_FILE || !CFX_LOG_FILE.exists) {
            CFX_LOG_FILE = new File(Folder.temp + "/LumaGrain-debug.log");
        }
        if (CFX_LOG_FILE.open("a")) {
            CFX_LOG_FILE.writeln(new Date().toString() + " | " + msg);
            CFX_LOG_FILE.close();
        }
    } catch (e) { /* logging must never break applying */ }
}

/* ExtendScript has no native JSON — join name arrays manually. */
function _cfx_joinNames(arr) {
    var out = "";
    for (var i = 0; i < arr.length; i++) {
        if (i) { out += ", "; }
        out += "'" + arr[i] + "'";
    }
    return out;
}

/* Minimal ES3 JSON serializer helpers for the result object. */
function _cfx_jsonEscape(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch === '"') { out += '\\"'; }
        else if (ch === "\\") { out += "\\\\"; }
        else if (ch === "\n" || ch === "\r") { out += " "; }
        else { out += ch; }
    }
    return out;
}

function _cfx_joinJson(arr) {
    var out = "";
    for (var i = 0; i < arr.length; i++) {
        if (i) { out += ","; }
        out += '"' + _cfx_jsonEscape(arr[i]) + '"';
    }
    return out;
}

function _cfx_resultToJson(r) {
    var parts = [];
    parts.push('"success":' + (r.success ? "true" : "false"));
    parts.push('"applied":[' + _cfx_joinJson(r.applied) + "]");

    var failed = "";
    for (var f = 0; f < r.failed.length; f++) {
        if (f) { failed += ","; }
        failed += '{"effect":"' + _cfx_jsonEscape(r.failed[f].effect) +
                  '","tried":[' + _cfx_joinJson(r.failed[f].tried) + "]}";
    }
    parts.push('"failed":[' + failed + "]");

    parts.push('"removed":[' + _cfx_joinJson(r.removed) + "]");

    var warns = "";
    for (var w = 0; w < r.warnings.length; w++) {
        if (w) { warns += ","; }
        warns += '"' + _cfx_jsonEscape(r.warnings[w]) + '"';
    }
    parts.push('"warnings":[' + warns + "]");

    parts.push('"message":"' + _cfx_jsonEscape(r.message) + '"');
    return "{" + parts.join(",") + "}";
}

/* Record an effect failure (with every name variant attempted). */
function _cfx_failEffect(effectName, triedNames, warnMsg) {
    CFX_RESULT.success = false;
    CFX_RESULT.failed.push({ effect: effectName, tried: triedNames });
    if (warnMsg && CFX_RESULT.warnings.length < 4) {
        CFX_RESULT.warnings.push(warnMsg);
    }
    _cfx_log("EFFECT-FAILED '" + effectName + "' tried: " + _cfx_joinNames(triedNames));
}

/* Non-fatal note. */
function _cfx_note(msg) {
    if (CFX_RESULT.warnings.length < 4) {
        CFX_RESULT.warnings.push(msg);
    }
}

/* ---------------------------------------------------------------------
   Utilities (ES3-safe)
   --------------------------------------------------------------------- */

function _cfx_clamp100(v, fallback) {
    var n = parseFloat(v);
    if (isNaN(n)) { n = fallback; }
    if (n < 0) { n = 0; }
    if (n > 100) { n = 100; }
    return n;
}

function _cfx_clamp(v, lo, hi) {
    if (isNaN(v)) { return lo; }
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
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
    var cfg = { grain: null, bloom: null, halation: null, lowshutter: null };
    var parts = String(s).split("|");
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        var ci = part.indexOf(":");
        if (ci < 0) { continue; }
        var name = part.substring(0, ci);
        var vals = part.substring(ci + 1).split(",");
        if (vals.length < 4) { continue; }
        if (name === "grain" || name === "bloom" ||
            name === "halation" || name === "lowshutter") {
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

/* Case-insensitive "contains any fragment" test. */
function _cfx_nameMatchesAny(name, fragments) {
    var nm = String(name).toLowerCase();
    if (!nm) { return false; }
    for (var i = 0; i < fragments.length; i++) {
        if (nm.indexOf(String(fragments[i]).toLowerCase()) >= 0) { return true; }
    }
    return false;
}

/* ---------------------------------------------------------------------
   Clip resolution — official DOM
   --------------------------------------------------------------------- */

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
   QE DOM helpers — name variants, verified adds, verified removals
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

        if (desc.node && desc.node !== "undefined") {
            var qNode = "";
            try { qNode = String(item.nodeId); } catch (e3) { qNode = ""; }
            if (qNode && qNode === desc.node) { return item; }
        }
        if (nonEmptyIndex === desc.clipIndex) { fallback = item; }
        nonEmptyIndex++;
    }
    return fallback;
}

function _cfx_effectNameAt(list, i) {
    try {
        if (list.numItems !== undefined && list.numItems !== null) {
            if (i >= list.numItems) { return ""; }
            return String(list[i]);
        }
    } catch (eA) { }
    try { return String(list[i]); } catch (eB) { return ""; }
}

/* Builds the full candidate list for an effect, in the required order:
   "AE.ADBE X" -> "PR.ADBE X" -> "ADBE X" -> display name variants. */
function _cfx_buildNameCandidates(baseNames) {
    var out = [];
    for (var i = 0; i < baseNames.length; i++) {
        var base = baseNames[i];
        out.push("AE." + base);
        out.push("PR." + base);
        out.push(base);
    }
    for (var j = 0; j < baseNames.length; j++) {
        var b = baseNames[j];
        if (b.indexOf("ADBE ") === 0) {
            out.push(b.substring(5));
        }
    }
    return out;
}

/* Resolves a QE effect object by matching the REAL effect list against
   every candidate (exact, case-insensitive; then substring preferring
   the shortest name so "Noise" beats "Noise HLS"). */
function _cfx_resolveQeEffect(candidates, triedOut) {
    var list = null;
    try { list = qe.project.getVideoEffectList(); } catch (eL) { list = null; }
    if (!list) { return null; }

    var count = 0;
    try {
        if (list.numItems !== undefined && list.numItems !== null) { count = list.numItems; }
        else { count = list.length; }
    } catch (eC) { count = 0; }
    if (!count) { return null; }

    for (var t = 0; t < candidates.length; t++) {
        var dup = false;
        for (var u = 0; u < triedOut.length; u++) {
            if (String(triedOut[u]).toLowerCase() === String(candidates[t]).toLowerCase()) { dup = true; break; }
        }
        if (!dup) { triedOut.push(candidates[t]); }
    }

    var i, k, name;
    for (k = 0; k < candidates.length; k++) {
        var want = String(candidates[k]).toLowerCase();
        for (i = 0; i < count; i++) {
            name = _cfx_effectNameAt(list, i);
            if (name.toLowerCase() === want) {
                try { return qe.project.getVideoEffectByName(name); } catch (e5) { }
            }
        }
    }
    for (k = 0; k < candidates.length; k++) {
        var want2 = String(candidates[k]).toLowerCase();
        var best = null, bestLen = -1;
        for (i = 0; i < count; i++) {
            name = _cfx_effectNameAt(list, i);
            var ln = name.length;
            if (ln > 0 && name.toLowerCase().indexOf(want2) >= 0 &&
                (bestLen < 0 || ln < bestLen)) {
                best = name;
                bestLen = ln;
            }
        }
        if (best) {
            try { return qe.project.getVideoEffectByName(best); } catch (e7) { }
        }
    }
    return null;
}

/* Component/effect count on a QE clip; tries numVideoEffects then
   numComponents. Returns -1 when neither is available. */
function _cfx_qeComponentCount(qeClip) {
    try {
        var n = qeClip.numVideoEffects;
        if (typeof n === "number") { return n; }
    } catch (eQ1) { }
    try {
        var n2 = qeClip.numComponents;
        if (typeof n2 === "number") { return n2; }
    } catch (eQ2) { }
    return -1;
}

/* Reads a QE effect's display name with fallbacks. */
function _cfx_qeEffectName(fx) {
    var nm = "";
    try { nm = String(fx.name); } catch (xN1) { nm = ""; }
    if (!nm) { try { nm = String(fx.matchName); } catch (xN2) { nm = ""; } }
    if (!nm) { try { nm = String(fx.displayName); } catch (xN3) { nm = ""; } }
    return nm;
}

/* ---------------------------------------------------------------------
   QE removal — method discovered at RUNTIME via ExtendScript reflection
   (qeClip.reflect.methods), because the QE removal API is undocumented
   and differs between Premiere builds. Known candidates are tried in
   order; the first one that exists on this build is cached.
   --------------------------------------------------------------------- */
var CFX_QE_REMOVE_PLAN = null; /* cached {name, arity} for this session */

var CFX_QE_REMOVE_CANDIDATES = [
    { name: "removeVideoEffectAt",        arity: 1 },  /* index variant */
    { name: "removeVideoEffectByIndex",   arity: 1 },
    { name: "removeVideoEffect",          arity: 1 },  /* object variant */
    { name: "removeEffect",               arity: 1 },
    { name: "removeVideoEffectAtIndex",   arity: 1 }
];

/* Finds the working removal method for this Premiere build. Returns
   {name, byIndex} or null. Uses reflect.methods when available, then
   probes by calling with a safe sentinel if reflection is absent. */
function _cfx_qeDiscoverRemoveMethod(qeClip) {
    if (CFX_QE_REMOVE_PLAN) { return CFX_QE_REMOVE_PLAN; }

    /* 1) Reflection: list the clip's real method names. */
    var names = [];
    try {
        var refl = qeClip.reflect;
        if (refl && refl.methods) {
            for (var m = 0; m < refl.methods.length; m++) {
                var mn = "";
                try { mn = String(refl.methods[m].name); } catch (xM) { mn = ""; }
                if (mn) { names.push(mn); }
            }
        }
    } catch (xR) { names = []; }

    var i, c;
    if (names.length) {
        for (i = 0; i < CFX_QE_REMOVE_CANDIDATES.length; i++) {
            c = CFX_QE_REMOVE_CANDIDATES[i];
            for (var n2 = 0; n2 < names.length; n2++) {
                if (names[n2] === c.name) {
                    CFX_QE_REMOVE_PLAN = { name: c.name, byIndex: (c.name.indexOf("At") >= 0 || c.name.indexOf("Index") >= 0) };
                    _cfx_log("REMOVE-METHOD discovered: " + c.name);
                    return CFX_QE_REMOVE_PLAN;
                }
            }
        }
    }

    /* 2) No reflection — probe by direct property test. */
    for (i = 0; i < CFX_QE_REMOVE_CANDIDATES.length; i++) {
        c = CFX_QE_REMOVE_CANDIDATES[i];
        try {
            if (typeof qeClip[c.name] === "function") {
                CFX_QE_REMOVE_PLAN = { name: c.name, byIndex: (c.name.indexOf("At") >= 0 || c.name.indexOf("Index") >= 0) };
                _cfx_log("REMOVE-METHOD probed: " + c.name);
                return CFX_QE_REMOVE_PLAN;
            }
        } catch (xP) { }
    }

    _cfx_log("REMOVE-METHOD: none found on this build");
    return null;
}

/* Removes one QE effect using the discovered method. Returns true when
   the clip's component count actually decreased. */
function _cfx_qeRemoveOne(qeClip, index, fx) {
    var plan = _cfx_qeDiscoverRemoveMethod(qeClip);
    if (!plan) { return false; }

    var before = _cfx_qeComponentCount(qeClip);
    try {
        if (plan.byIndex) {
            qeClip[plan.name](index);
        } else if (fx) {
            qeClip[plan.name](fx);
        } else {
            return false;
        }
    } catch (xCall) {
        _cfx_log("REMOVE-CALL threw for " + plan.name + "(" + index + "): " + xCall);
        return false;
    }

    var after = _cfx_qeComponentCount(qeClip);
    if (before >= 0 && after >= 0) {
        return after < before;
    }
    return true; /* count unavailable — assume the call succeeded */
}

/* Finds an existing component (no duplicates rule). */
function _cfx_findComponent(clip, matchNames, displayNames) {
    if (!clip) { return null; }
    var comps = clip.components;
    if (!comps) { return null; }
    var n = comps.numItems;
    for (var i = 0; i < n; i++) {
        var comp = comps[i];
        if (!comp) { continue; }
        var mn = "", dn = "";
        try { mn = String(comp.matchName); } catch (e8) { mn = ""; }
        try { dn = String(comp.displayName); } catch (e9) { dn = ""; }
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

/* True when the clip still has any component from matchNames. */
function _cfx_hasAnyComponent(clip, matchNames) {
    return _cfx_findComponent(clip, matchNames, null) !== null;
}

/* Adds an effect if not already present, trying each QE name variant
   until the component count actually increases. Returns
   "added" | "exists" | "failed". */
function _cfx_ensureEffect(desc, baseNames, matchNames, displayNames) {
    var clip = _cfx_resolveClip(desc);
    if (_cfx_findComponent(clip, matchNames, displayNames)) { return "exists"; }

    var qeClip = _cfx_qeClipFor(desc);
    if (!qeClip) { return "failed"; }

    var candidates = _cfx_buildNameCandidates(baseNames);
    var tried = [];

    for (var v = 0; v < candidates.length; v++) {
        var fx = _cfx_resolveQeEffect([candidates[v]], tried);
        if (!fx) { continue; }

        var before = _cfx_qeComponentCount(qeClip);
        try {
            qeClip.addVideoEffect(fx);
        } catch (e17) {
            _cfx_log("ADD-THREW for '" + candidates[v] + "': " + e17);
            continue;
        }

        var after = _cfx_qeComponentCount(qeClip);
        if (before >= 0 && after >= 0 && after > before) {
            return "added";
        }

        /* Count delta unavailable in this build — poll the official DOM. */
        for (var attempt = 0; attempt < 8; attempt++) {
            clip = _cfx_resolveClip(desc);
            if (_cfx_findComponent(clip, matchNames, displayNames)) { return "added"; }
            try { $.sleep(40); } catch (e18) { break; }
        }
        /* Cannot verify and poll found nothing: assume this variant
           landed (double-add is guarded by the exists-check on next
           Apply) rather than stacking more variants blindly. */
        if (before < 0) { return "added"; }
    }
    return "failed";
}

/* ---------------------------------------------------------------------
   REMOVAL — QE DOM, backwards index loop, shared-component safe
   --------------------------------------------------------------------- */

/* Removes every QE component belonging to groupKey, EXCEPT components
   whose name also matches a fragment of a group that is currently ON
   (Fast Blur and Brightness & Contrast are shared between recipes).
   Uses the runtime-DISCOVERED removal method (see reflection helper),
   verifies each removal with a count delta, and sweeps ALL indices
   (0..count-1), repeating passes until one pass removes nothing.
   Returns "removed" | "absent" | "failed". */
function _cfx_removeEffectGroup(desc, groupKey, onKeys) {
    var group = CFX_GROUPS[groupKey];
    if (!group) { return "absent"; }

    /* Fragments to keep: union of the ON groups' fragments. */
    var keepFragments = [];
    for (var k = 0; k < onKeys.length; k++) {
        var g = CFX_GROUPS[onKeys[k]];
        if (!g) { continue; }
        for (var f = 0; f < g.fragments.length; f++) {
            var frag = String(g.fragments[f]).toLowerCase();
            if (keepFragments.indexOf(frag) < 0) { keepFragments.push(frag); }
        }
    }

    var qeClip = _cfx_qeClipFor(desc);
    if (!qeClip) { return "failed"; }

    var plan = _cfx_qeDiscoverRemoveMethod(qeClip);
    if (!plan) {
        _cfx_log("REMOVE-ABORT: no removal method on this build for '" +
                 group.label + "'");
        return "failed";
    }

    var count = _cfx_qeComponentCount(qeClip);
    if (count < 0) { count = 64; } /* conservative sweep bound */

    var removedCount = 0;
    var pass, i;

    /* Up to 4 passes — each removal shifts indices, so sweep again
       until a full pass removes nothing. Backwards within each pass. */
    for (pass = 0; pass < 4; pass++) {
        var removedThisPass = 0;
        for (i = count - 1; i >= 0; i--) {
            var fx = null;
            try { fx = qeClip.getVideoEffectAt(i); } catch (xR1) { fx = null; }
            if (!fx) {
                try { fx = qeClip.getComponentAt(i); } catch (xR2) { fx = null; }
            }
            if (!fx) { continue; }

            var nm = _cfx_qeEffectName(fx);
            if (!nm) { continue; }
            if (!_cfx_nameMatchesAny(nm, group.fragments)) { continue; }

            /* Shared-component guard: keep if an ON group wants it. */
            if (keepFragments.length && _cfx_nameMatchesAny(nm, keepFragments)) {
                continue;
            }

            if (_cfx_qeRemoveOne(qeClip, i, fx)) {
                removedCount++;
                removedThisPass++;
            } else {
                _cfx_log("REMOVE-FAILED '" + nm + "' (index " + i + ", method " + plan.name + ")");
            }
        }
        if (removedThisPass === 0) { break; }
        var newCount = _cfx_qeComponentCount(qeClip);
        if (newCount >= 0) { count = newCount; } else { break; }
    }

    if (removedCount > 0) { return "removed"; }

    /* Nothing removed: either the group wasn't present ("absent") or
       the removal API silently failed ("failed"). Decide via official
       DOM on the group's unique components. */
    var clip = _cfx_resolveClip(desc);
    if (!_cfx_hasAnyComponent(clip, group.verifyMatchNames)) {
        return "absent";
    }
    _cfx_log("REMOVE-NOOP for '" + group.label + "' (method " + plan.name + ")");
    return "failed";
}

/* NEUTRALIZE fallback — when components cannot be removed on this
   Premiere build, drive their parameters to "invisible" instead so the
   look disappears even though the effect technically remains:
     Grain      -> Noise amount = 0, blur blurriness = 0
     Bloom      -> glow intensity = 0
     Halation   -> red blurriness = 0, tint amount = 0
     LowShutter -> blur length = 0, ghost blurriness = 0, brightness 0
   Only touches components this group owns (shared blur is left alone
   when another effect is ON). */
function _cfx_neutralizeGroup(desc, groupKey) {
    var clip = _cfx_resolveClip(desc);
    if (!clip) { return false; }

    var zero = function (compMatchNames, compDisplayNames, specs) {
        var comp = _cfx_findComponent(clip, compMatchNames, compDisplayNames);
        if (!comp) { return; }
        for (var s = 0; s < specs.length; s++) {
            try { _cfx_setPropInGroups(comp, specs[s], "neutralize"); } catch (xz) { }
        }
    };

    if (groupKey === "grain") {
        zero(["ADBE Noise"], ["Noise"],
            [{ names: ["Amount of Noise", "ADBE Noise-0001", "Amount"], value: 0, min: 0, max: 50, idx: 0 }]);
    }
    if (groupKey === "bloom") {
        zero(["ADBE VR Glow", "ADBE VRGlow"], ["VR Glow"],
            [{ names: ["Glow Intensity", "GlowIntensity", "Intensity"], value: 0, min: 0, max: 100, idx: 3 }]);
    }
    if (groupKey === "halation") {
        zero(["ADBE Channel Blur"], ["Channel Blur"],
            [{ names: ["Red Blurriness", "ADBE Channel Blur-0001", "Red"], value: 0, min: 0, max: 35, idx: 0 }]);
        zero(["ADBE Tint"], ["Tint"],
            [{ names: ["Amount to Tint", "ADBE Tint-0003", "Amount"], value: 0, min: 0, max: 30, idx: 2 }]);
    }
    if (groupKey === "lowshutter") {
        zero(["ADBE Motion Blur", "ADBE Directional Blur", "ADBE DirectionalBlur"],
            ["Directional Blur", "Motion Blur"],
            [{ names: ["Blur Length", "ADBE Motion Blur-0002", "ADBE Directional Blur-0002"],
              value: 0, min: 0, max: 30, idx: 1 }]);
    }
    return true;
}

/* ---------------------------------------------------------------------
   Parameter writing — official DOM, three tiers + groups
   --------------------------------------------------------------------- */

function _cfx_trySetValue(prop, value) {
    try { prop.setValue(value, true); return true; } catch (x1) { }
    try { prop.setValue(value); return true; } catch (x2) { }
    if (value === true || value === false) {
        try {
            var cur = prop.getValue();
            if (cur !== value) { prop.setValue(!cur, true); return true; }
            return true;
        } catch (x3) { }
    }
    return false;
}

function _cfx_setProp(comp, spec, label) {
    if (!comp) { return false; }
    var props = comp.properties;
    if (!props) { return false; }

    var value = spec.value;
    if (spec.min !== undefined && spec.max !== undefined &&
        typeof value === "number") {
        value = _cfx_clamp(value, spec.min, spec.max);
    }

    var n = props.numItems;
    var cands = spec.names;
    var i, k, dn, mn;

    /* tier 1 — prefix */
    for (i = 0; i < n; i++) {
        var p1 = props[i];
        if (!p1) { continue; }
        dn = ""; mn = "";
        try { dn = String(p1.displayName).toLowerCase(); } catch (xD) { dn = ""; }
        try { mn = String(p1.matchName).toLowerCase(); } catch (xE) { mn = ""; }
        for (k = 0; k < cands.length; k++) {
            var c1 = String(cands[k]).toLowerCase();
            if ((dn && dn.indexOf(c1) === 0) || (mn && mn.indexOf(c1) === 0)) {
                if (_cfx_trySetValue(p1, value)) { return true; }
            }
        }
    }

    /* tier 2 — contains */
    for (i = 0; i < n; i++) {
        var p2 = props[i];
        if (!p2) { continue; }
        dn = ""; mn = "";
        try { dn = String(p2.displayName).toLowerCase(); } catch (xF) { dn = ""; }
        try { mn = String(p2.matchName).toLowerCase(); } catch (xG) { mn = ""; }
        for (k = 0; k < cands.length; k++) {
            var c2 = String(cands[k]).toLowerCase();
            if ((dn && dn.indexOf(c2) >= 0) || (mn && mn.indexOf(c2) >= 0)) {
                if (_cfx_trySetValue(p2, value)) { return true; }
            }
        }
    }

    /* tier 3 — positional index */
    if (spec.idx !== undefined && spec.idx >= 0 && spec.idx < n) {
        if (_cfx_trySetValue(props[spec.idx], value)) { return true; }
    }

    if (spec.optional) {
        _cfx_log("SKIPPED (optional) '" + label + "' " + _cfx_joinNames(spec.names));
        return true;
    }

    _cfx_log("WRITE-FAILED '" + label + "' wanted " +
             _cfx_joinNames(spec.names) + "=" + value);
    return false;
}

/* Color parameter write with fallbacks (setColorValue orders differ). */
function _cfx_setColorProp(comp, spec, label) {
    if (!comp) { return false; }
    var props = comp.properties;
    if (!props) { return false; }
    var n = props.numItems;
    var cands = spec.names;
    var i, k, dn, mn;

    var tries = [function (p) { p.setColorValue(255, spec.r, spec.g, spec.b); },
                 function (p) { p.setColorValue(spec.r, spec.g, spec.b, 255); },
                 function (p) { p.setValue([spec.r, spec.g, spec.b, 255], true); },
                 function (p) { p.setValue([spec.r, spec.g, spec.b], true); }];

    for (var tier = 0; tier < 2; tier++) {
        for (i = 0; i < n; i++) {
            var p = props[i];
            if (!p) { continue; }
            dn = ""; mn = "";
            try { dn = String(p.displayName).toLowerCase(); } catch (xH) { dn = ""; }
            try { mn = String(p.matchName).toLowerCase(); } catch (xI) { mn = ""; }
            for (k = 0; k < cands.length; k++) {
                var c = String(cands[k]).toLowerCase();
                var hit = (tier === 0)
                    ? ((dn && dn.indexOf(c) === 0) || (mn && mn.indexOf(c) === 0))
                    : ((dn && dn.indexOf(c) >= 0) || (mn && mn.indexOf(c) >= 0));
                if (hit) {
                    for (var t = 0; t < tries.length; t++) {
                        try { tries[t](p); return true; } catch (xJ) { }
                    }
                }
            }
        }
    }

    if (spec.idx !== undefined && spec.idx >= 0 && spec.idx < n) {
        for (var t2 = 0; t2 < tries.length; t2++) {
            try { tries[t2](props[spec.idx]); return true; } catch (xK) { }
        }
    }

    _cfx_log("COLOR-FAILED '" + label + "' wanted " + _cfx_joinNames(spec.names));
    return false;
}

/* Writes into named sub-groups if a direct write fails. */
function _cfx_setPropInGroups(comp, spec, label) {
    if (_cfx_setProp(comp, spec, label)) { return true; }
    try {
        var props = comp.properties;
        var n = props.numItems;
        for (var i = 0; i < n; i++) {
            var g = props[i];
            if (!g) { continue; }
            var sub = null;
            try { sub = g.properties; } catch (xL) { sub = null; }
            if (sub && sub.numItems && sub.numItems > 0) {
                if (_cfx_setProp(g, spec, label + ">" + i)) { return true; }
            }
        }
    } catch (xM) { }
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
    return _cfx_setProp(oc, { names: ["Blend Mode", "ADBE Opacity-0002"], value: CFX_BLEND_SCREEN },
                        "blend-mode");
}

function _cfx_setClipMix(desc, percent) {
    var oc = _cfx_opacityComponent(desc);
    if (!oc) { return false; }
    return _cfx_setProp(oc, { names: ["Opacity", "ADBE Opacity-0001"],
                              value: Math.round(percent), min: 0, max: 100 },
                        "clip-mix");
}

/* Sets parameters via the official DOM. */
function _cfx_applyParams(desc, compMatchNames, compDisplayNames,
                          paramSpecs, colorSpecs, label) {
    var clip = _cfx_resolveClip(desc);
    var comp = _cfx_findComponent(clip, compMatchNames, compDisplayNames);
    if (!comp) {
        _cfx_note(label + ": effect present but not addressable — defaults kept.");
        return false;
    }

    var ok = true;
    var i;
    for (i = 0; i < paramSpecs.length; i++) {
        if (!_cfx_setPropInGroups(comp, paramSpecs[i], label)) { ok = false; }
    }
    for (i = 0; i < colorSpecs.length; i++) {
        if (!_cfx_setColorProp(comp, colorSpecs[i], label)) { ok = false; }
    }
    if (!ok) {
        _cfx_note(label + ": some parameters could not be set " +
                  "(see %TEMP%\\LumaGrain-debug.log).");
    }
    return ok;
}

/* ---------------------------------------------------------------------
   RECIPES
   --------------------------------------------------------------------- */

/* FILM GRAIN */
function _cfx_applyGrain(desc, cfg) {
    var stBlur = _cfx_ensureEffect(desc,
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"],
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"], ["Fast Blur", "Gaussian Blur"]);
    if (stBlur === "failed") {
        _cfx_failEffect("Film Grain (size pass)", ["Fast Blur", "Gaussian Blur"],
                        "Film Grain: blur (size pass) unavailable.");
    } else {
        _cfx_applyParams(desc,
            ["ADBE Fast Blur", "ADBE Gaussian Blur 2"], ["Fast Blur", "Gaussian Blur"],
            [
                { names: ["Blurriness", "ADBE Fast Blur-0001", "ADBE Gaussian Blur 2-0001"],
                  value: Math.round(cfg.size * 0.04), min: 0, max: 500, idx: 0 },
                { names: ["Repeat Edge Pixel", "ADBE Fast Blur-0003", "Repeat Edge Pixels"],
                  value: true, idx: 2, optional: true }
            ],
            [], "Film Grain (size pass)");
    }

    var st = _cfx_ensureEffect(desc,
        ["ADBE Noise"], ["ADBE Noise"], ["Noise"]);
    if (st === "failed") {
        _cfx_failEffect("Film Grain", ["AE.ADBE Noise", "PR.ADBE Noise", "ADBE Noise", "Noise"],
                        "Film Grain: could not add Noise.");
        return;
    }

    var amount = Math.round((cfg.intensity / 100) * (cfg.opacity / 100) * 20);
    _cfx_applyParams(desc,
        ["ADBE Noise"], ["Noise"],
        [
            { names: ["Amount of Noise", "ADBE Noise-0001", "Amount"],
              value: amount, min: 0, max: 50, idx: 0 },
            { names: ["Use Color Noise", "ADBE Noise-0002"], value: false, idx: 1, optional: true },
            { names: ["Clipping", "Clip", "ADBE Noise-0003"], value: true, idx: 2, optional: true }
        ],
        [], "Film Grain");
}

/* BLOOM — VR Glow primary, Fast Blur + B&C + Screen fallback. */
function _cfx_applyBloom(desc, cfg) {
    var st = _cfx_ensureEffect(desc,
        ["ADBE VR Glow"],
        ["ADBE VR Glow", "ADBE VRGlow"], ["VR Glow"]);

    if (st !== "failed") {
        _cfx_applyParams(desc,
            ["ADBE VR Glow", "ADBE VRGlow"], ["VR Glow"],
            [
                { names: ["Glow Intensity", "GlowIntensity", "Intensity"],
                  value: Math.round(cfg.intensity), min: 0, max: 100, idx: 3 },
                { names: ["Glow Radius", "GlowRadius", "Radius"],
                  value: Math.round(cfg.size), min: 0, max: 1000, idx: 2 },
                { names: ["Glow Brightness", "GlowBrightness", "Brightness"],
                  value: Math.round(cfg.opacity), min: 0, max: 100, idx: 4 }
            ],
            [], "Bloom");
        return;
    }

    var stBlur = _cfx_ensureEffect(desc,
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"],
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"], ["Fast Blur", "Gaussian Blur"]);
    if (stBlur === "failed") {
        _cfx_failEffect("Bloom", ["VR Glow", "Fast Blur"], "Bloom: could not add any glow effect.");
        return;
    }

    _cfx_applyParams(desc,
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"], ["Fast Blur", "Gaussian Blur"],
        [
            { names: ["Blurriness", "ADBE Fast Blur-0001", "ADBE Gaussian Blur 2-0001"],
              value: Math.round(cfg.size), min: 0, max: 500, idx: 0 },
            { names: ["Repeat Edge Pixel", "ADBE Fast Blur-0003", "Repeat Edge Pixels"],
              value: true, idx: 2, optional: true }
        ],
        [], "Bloom (blur)");

    var stBC = _cfx_ensureEffect(desc,
        ["ADBE Brightness & Contrast"],
        ["ADBE Brightness & Contrast"], ["Brightness & Contrast"]);
    if (stBC !== "failed") {
        _cfx_applyParams(desc,
            ["ADBE Brightness & Contrast"], ["Brightness & Contrast"],
            [
                { names: ["Brightness", "ADBE Brightness & Contrast-0001"],
                  value: Math.round(cfg.intensity * 0.6 - 10), min: -100, max: 100, idx: 0 }
            ],
            [], "Bloom (intensity)");
    }

    if (!_cfx_setBlendScreen(desc)) {
        _cfx_note("Bloom: could not set Screen blend mode.");
    }
    if (!_cfx_setClipMix(desc, cfg.opacity)) {
        _cfx_note("Bloom: could not set clip mix.");
    }
}

/* HALATION — highlights-only warm bleed. */
function _cfx_applyHalation(desc, cfg) {
    var st = _cfx_ensureEffect(desc,
        ["ADBE Channel Blur"],
        ["ADBE Channel Blur"], ["Channel Blur"]);
    if (st === "failed") {
        _cfx_failEffect("Halation", ["AE.ADBE Channel Blur", "PR.ADBE Channel Blur",
                                     "ADBE Channel Blur", "Channel Blur"],
                        "Halation: could not add Channel Blur.");
        return;
    }

    var redSpread = Math.round(cfg.size * 0.35);            /* max 35 */
    _cfx_applyParams(desc,
        ["ADBE Channel Blur"], ["Channel Blur"],
        [
            { names: ["Red Blurriness", "ADBE Channel Blur-0001", "Red"],
              value: redSpread, min: 0, max: 35, idx: 0 },
            { names: ["Green Blurriness", "ADBE Channel Blur-0002", "Green"],
              value: 0, min: 0, max: 100, idx: 1 },
            { names: ["Blue Blurriness", "ADBE Channel Blur-0003", "Blue"],
              value: 0, min: 0, max: 100, idx: 2 },
            { names: ["Alpha Blurriness", "ADBE Channel Blur-0004", "Alpha"],
              value: 0, min: 0, max: 100, idx: 3, optional: true },
            { names: ["Repeat Edge Pixel", "ADBE Channel Blur-0005", "Repeat Edge Pixels"],
              value: true, idx: 4, optional: true }
        ],
        [], "Halation (red bleed)");

    var stBC = _cfx_ensureEffect(desc,
        ["ADBE Brightness & Contrast"],
        ["ADBE Brightness & Contrast"], ["Brightness & Contrast"]);
    if (stBC !== "failed") {
        _cfx_applyParams(desc,
            ["ADBE Brightness & Contrast"], ["Brightness & Contrast"],
            [
                { names: ["Brightness", "ADBE Brightness & Contrast-0001"],
                  value: Math.round(cfg.intensity * 0.12), min: 0, max: 12, idx: 0 }
            ],
            [], "Halation (lift)");
    }

    var stTint = _cfx_ensureEffect(desc,
        ["ADBE Tint"], ["ADBE Tint"], ["Tint"]);
    if (stTint === "failed") {
        _cfx_note("Halation: Tint unavailable (warmth not applied).");
    } else {
        var warmR = 255;
        var warmG = Math.round(160 * (cfg.intensity / 100));
        var warmB = Math.round(80 * (cfg.intensity / 100));
        _cfx_applyParams(desc,
            ["ADBE Tint"], ["Tint"],
            [
                { names: ["Amount to Tint", "ADBE Tint-0003", "Amount"],
                  value: Math.round(cfg.opacity * 0.3), min: 0, max: 30, idx: 2 }
            ],
            [
                { names: ["Map Black To", "ADBE Tint-0001"], r: 0, g: 0, b: 0, idx: 0 },
                { names: ["Map White To", "ADBE Tint-0002"], r: warmR, g: warmG, b: warmB, idx: 1 }
            ], "Halation (warmth)");
    }

    /* Lumetri Temperature ONLY if Lumetri already exists — never added. */
    var clip = _cfx_resolveClip(desc);
    var lum = _cfx_findComponent(clip, ["AE.ADBE Lumetri"], ["Lumetri Color"]);
    if (lum) {
        _cfx_applyParams(desc,
            ["AE.ADBE Lumetri"], ["Lumetri Color"],
            [
                { names: ["Temperature", "ADBE Lumetri-0002"],
                  value: Math.round(cfg.intensity * 0.3), min: 0, max: 30, idx: 0, optional: true }
            ],
            [], "Halation (Lumetri temp)");
    }
}

/* LOW SHUTTER — low shutter angle feel. */
function _cfx_applyLowShutter(desc, cfg) {
    var stDir = _cfx_ensureEffect(desc,
        ["ADBE Motion Blur", "ADBE Directional Blur"],
        ["ADBE Motion Blur", "ADBE Directional Blur", "ADBE DirectionalBlur"],
        ["Directional Blur", "Motion Blur"]);
    if (stDir === "failed") {
        _cfx_failEffect("Low Shutter", ["AE.ADBE Motion Blur", "PR.ADBE Motion Blur",
                                        "ADBE Motion Blur", "AE.ADBE Directional Blur",
                                        "ADBE Directional Blur", "Directional Blur"],
                        "Low Shutter: could not add Directional Blur.");
        return;
    }

    var blurLength = (cfg.intensity * cfg.size * cfg.opacity) / 1000000 * 30;
    if (blurLength > 30) { blurLength = 30; }
    _cfx_applyParams(desc,
        ["ADBE Motion Blur", "ADBE Directional Blur", "ADBE DirectionalBlur"],
        ["Directional Blur", "Motion Blur"],
        [
            { names: ["Direction", "ADBE Motion Blur-0001", "ADBE Directional Blur-0001"],
              value: 90, min: 0, max: 360, idx: 0 },
            { names: ["Blur Length", "ADBE Motion Blur-0002", "ADBE Directional Blur-0002"],
              value: Math.round(blurLength * 100) / 100, min: 0, max: 30, idx: 1 }
        ],
        [], "Low Shutter (motion blur)");

    var stGhost = _cfx_ensureEffect(desc,
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"],
        ["ADBE Fast Blur", "ADBE Gaussian Blur 2"], ["Fast Blur", "Gaussian Blur"]);
    if (stGhost !== "failed") {
        _cfx_applyParams(desc,
            ["ADBE Fast Blur", "ADBE Gaussian Blur 2"], ["Fast Blur", "Gaussian Blur"],
            [
                { names: ["Blurriness", "ADBE Fast Blur-0001", "ADBE Gaussian Blur 2-0001"],
                  value: Math.round(cfg.intensity * 0.08 * 100) / 100, min: 0, max: 8, idx: 0 },
                { names: ["Repeat Edge Pixel", "ADBE Fast Blur-0003", "Repeat Edge Pixels"],
                  value: true, idx: 2, optional: true }
            ],
            [], "Low Shutter (ghosting)");
    }

    var stBC = _cfx_ensureEffect(desc,
        ["ADBE Brightness & Contrast"],
        ["ADBE Brightness & Contrast"], ["Brightness & Contrast"]);
    if (stBC !== "failed") {
        _cfx_applyParams(desc,
            ["ADBE Brightness & Contrast"], ["Brightness & Contrast"],
            [
                { names: ["Brightness", "ADBE Brightness & Contrast-0001"],
                  value: -Math.round(cfg.intensity * 0.05), min: -5, max: 0, idx: 0 }
            ],
            [], "Low Shutter (exposure)");
    }
}

/* ---------------------------------------------------------------------
   Main entry point — ONE call: removals for OFF effects, applies for ON
   --------------------------------------------------------------------- */
function cinemaFX_apply(payload) {
    CFX_RESULT = _cfx_newResult();

    try {
        if (!app.project) {
            CFX_RESULT.message = "No project open. Create or open a project first.";
            return _cfx_resultToJson(CFX_RESULT);
        }

        app.enableQE();

        var seq = app.project.activeSequence;
        if (!seq) {
            CFX_RESULT.message = "No active sequence. Open or click into a sequence first.";
            return _cfx_resultToJson(CFX_RESULT);
        }

        var cfg = _cfx_parsePayload(payload);
        var anyEnabled = (cfg.grain && cfg.grain.enabled) ||
                         (cfg.bloom && cfg.bloom.enabled) ||
                         (cfg.halation && cfg.halation.enabled) ||
                         (cfg.lowshutter && cfg.lowshutter.enabled);

        var descs = _cfx_getSelectedClipDescriptors();
        if (descs.length === 0) {
            CFX_RESULT.success = false;
            CFX_RESULT.message = "No clips selected. Select one or more clips in the timeline.";
            return _cfx_resultToJson(CFX_RESULT);
        }

        var keys = ["grain", "bloom", "halation", "lowshutter"];
        var onKeys = [];
        for (var k0 = 0; k0 < keys.length; k0++) {
            if (cfg[keys[k0]] && cfg[keys[k0]].enabled) { onKeys.push(keys[k0]); }
        }

        /* Per-effect outcome tracking (effect-level, not per-clip). */
        var appliedKeys = {};        /* key -> true when apply ran */
        var removedKeys = {};        /* key -> true when removal (or neutralize) succeeded */
        var removedNeutralized = {}; /* key -> true when only neutralized (not deleted) */
        var removedFailed = {};      /* key -> true when any removal failed */

        var okClips = 0;
        for (var c = 0; c < descs.length; c++) {
            var desc = descs[c];
            try {
                /* 1) REMOVALS first — every OFF effect must go. Shared
                      components wanted by ON effects are kept. If the
                      removal API can't remove on this build, neutralize
                      the group's parameters instead (visually identical
                      to removal). */
                for (var r = 0; r < keys.length; r++) {
                    var key = keys[r];
                    var on = cfg[key] && cfg[key].enabled;
                    if (on) { continue; }
                    var res = _cfx_removeEffectGroup(desc, key, onKeys);
                    if (res === "failed") {
                        /* Fallback: zero the group's visible parameters. */
                        var neutralized = false;
                        try { neutralized = _cfx_neutralizeGroup(desc, key); } catch (xN) { neutralized = false; }
                        if (neutralized) {
                            removedKeys[key] = true;
                            removedNeutralized[key] = true;
                            _cfx_log("NEUTRALIZED instead of removed: '" + CFX_GROUPS[key].label + "'");
                        } else {
                            removedFailed[key] = true;
                            _cfx_log("REMOVE-FAILED-GROUP '" + CFX_GROUPS[key].label + "'");
                        }
                    } else {
                        removedKeys[key] = true;
                    }
                }

                /* 2) APPLIES — glow/blur passes first, grain last, so
                      the grain is never softened by the blur stages. */
                for (var e = 0; e < onKeys.length; e++) {
                    var onKey = onKeys[e];
                    var ecfg = cfg[onKey];
                    if (onKey === "bloom") { _cfx_applyBloom(desc, ecfg); }
                    else if (onKey === "halation") { _cfx_applyHalation(desc, ecfg); }
                    else if (onKey === "lowshutter") { _cfx_applyLowShutter(desc, ecfg); }
                    else if (onKey === "grain") { _cfx_applyGrain(desc, ecfg); }
                    appliedKeys[onKey] = true;
                }
                okClips++;
            } catch (eClip) {
                _cfx_note("Clip " + (c + 1) + ": " + eClip.toString());
            }
        }

        if (okClips === 0) {
            CFX_RESULT.success = false;
            CFX_RESULT.message = "Effects could not be applied to the selected clips.";
            return _cfx_resultToJson(CFX_RESULT);
        }

        /* Compose result arrays (effect-level). */
        for (var a = 0; a < keys.length; a++) {
            var k1 = keys[a];
            var isOn = cfg[k1] && cfg[k1].enabled;
            if (isOn) {
                if (appliedKeys[k1]) {
                    CFX_RESULT.applied.push(CFX_GROUPS[k1].label);
                } else if (anyEnabled) {
                    /* recipe reported its own failure via _cfx_failEffect */
                }
            } else {
                if (removedFailed[k1]) {
                    _cfx_failEffect(CFX_GROUPS[k1].label + " (removal)",
                                    CFX_GROUPS[k1].fragments,
                                    "Could not remove " + CFX_GROUPS[k1].label +
                                    " — try removing it manually in Effect Controls.");
                } else {
                    CFX_RESULT.removed.push(
                        removedNeutralized[k1]
                            ? CFX_GROUPS[k1].label + " (disabled)"
                            : CFX_GROUPS[k1].label);
                }
            }
        }

        /* Human message. */
        var msgParts = [];
        if (CFX_RESULT.applied.length) {
            msgParts.push("Applied: " + CFX_RESULT.applied.join(", "));
        }
        if (CFX_RESULT.removed.length) {
            msgParts.push("Removed: " + CFX_RESULT.removed.join(", "));
        }
        if (!msgParts.length) {
            msgParts.push("Nothing to change.");
        }
        var msg = msgParts.join(" — ") + "  (" + okClips + " clip" +
                  (okClips === 1 ? "" : "s") + ", MPE GPU effects).";

        if (CFX_RESULT.failed.length) {
            var failedNames = [];
            for (var f2 = 0; f2 < CFX_RESULT.failed.length; f2++) {
                failedNames.push(CFX_RESULT.failed[f2].effect);
            }
            msg += " Failed: " + failedNames.join(", ") + ".";
        }
        if (CFX_RESULT.warnings.length) {
            msg += " Notes: " + CFX_RESULT.warnings.join(" ");
        }

        CFX_RESULT.message = msg;
        return _cfx_resultToJson(CFX_RESULT);

    } catch (eTop) {
        CFX_RESULT.success = false;
        CFX_RESULT.message = "Host error: " + eTop.toString();
        return _cfx_resultToJson(CFX_RESULT);
    }
}

/* Diagnostic entry point. */
function cinemaFX_status() {
    try {
        if (!app.project) { return '{"success":true,"message":"Host ready. No project open."}'; }
        var seq = app.project.activeSequence;
        var selCount = seq ? _cfx_getSelectedClipDescriptors().length : 0;
        return '{"success":true,"message":"Host ready. Sequence: ' +
               _cfx_jsonEscape(seq ? seq.name : "none") +
               '. Selected clips: ' + selCount + '"}';
    } catch (e) {
        return '{"success":false,"message":"' + _cfx_jsonEscape(e.toString()) + '"}';
    }
}
