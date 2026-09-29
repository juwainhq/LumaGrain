======================================================================
 LumaGrain — Cinematic Film Grain / Bloom / Halation for Premiere Pro
======================================================================

A CEP panel for Adobe Premiere Pro 2026 (Windows) that applies
cinematic Film Grain, Bloom and Halation using Premiere's NATIVE,
GPU-accelerated (MPE) video effects — applied entirely through
Premiere's scripting engine. No custom render plugins required.

  Extension ID : com.filmtools.cinemafx.panel
  Panel menu   : Window > Extensions > LumaGrain
  Panel size   : 320 x 520, dockable

----------------------------------------------------------------------
 WHAT IT APPLIES (native MPE GPU effects only)
----------------------------------------------------------------------
  Film Grain  : Fast Blur (grain size) + Noise (mono, clipped)
  Bloom       : VR Glow (native GPU glow). If VR Glow is unavailable,
                a classic Fast Blur + Brightness & Contrast rig with
                the clip blend mode set to Screen is used instead.
  Halation    : Channel Blur (RED channel only — highlights bleed) +
                slight Brightness lift + warm Tint (amount capped at
                30%). Highlights-only warm glow; never tints shadows.
                Lumetri Temperature is nudged only if Lumetri is
                already on the clip (it is never added).
  Low Shutter : Directional Blur (90° horizontal streaks) + subtle
                ghosting blur + slight exposure drop — the broken
                180° shutter-angle look.

 All four effects are applied in ONE batched call; pressing Apply
 twice never stacks duplicates. Live update: after the first Apply,
 slider changes and toggle changes push to Premiere automatically.
 The status bar shows per-effect success/failure (JSON result from
 the host).

----------------------------------------------------------------------
 INSTALLATION (Windows + Premiere Pro 2026)
----------------------------------------------------------------------

 Option A — One-click ZXP installer (recommended)

   1. Download the free ZXPInstaller (https://zxpinstaller.com)
      or Anastasiy's Extension Manager and install it.
   2. Double-click LumaGrain.zxp — or drag it onto the installer
      window.
   3. Approve the admin prompt (ZXP installs write to
      C:\Program Files (x86)\Common Files\Adobe\CEP\extensions).
   4. Start (or restart) Premiere Pro 2026.
   5. Open Window > Extensions > LumaGrain.

 Option B — Manual install (no tools needed)

   1. Copy the ENTIRE extension folder (the one containing
      CSXS\manifest.xml, index.html, main.js, jsx\, lib\, style.css)
      to:
        C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.filmtools.cinemafx\
   2. Start Premiere Pro 2026.
   3. Open Window > Extensions > LumaGrain.

 Note: Premiere Pro 2026 ships with CEP 12, so the panel loads
 without any PlayerDebugMode registry tweak. Only if you are also
 testing on older Premiere builds (13.x or earlier) would you need
 to enable PlayerDebugMode: run "regedit", navigate to
 HKEY_CURRENT_USER\Software\Adobe\CSXS.12, add String value
 PlayerDebugMode = 1, and restart Premiere.

----------------------------------------------------------------------
 USING THE PANEL
----------------------------------------------------------------------

 1. Select one or more clips in a timeline.
 2. Toggle Film Grain / Bloom / Halation on (the card expands to
    reveal its sliders; collapsing the card never disables it).
 3. Adjust Intensity / Size / Opacity — live readouts update as you
    drag; settings persist across panel reloads.
 4. Click APPLY EFFECTS. All enabled effects are applied to every
    selected clip in one ExtendScript call (each effect lands as its
    own entry in Premiere's Edit > Undo stack — undo repeatedly to
    step back through them).
 5. Status bar (bottom) shows the last action or any error inline.

 Halation and Bloom blend best when the clip sits ABOVE your base
 footage (e.g. on an adjustment layer above the edit); on a bottom
 track there is nothing underneath to blend against.

----------------------------------------------------------------------
 BUILD THE ZXP YOURSELF (build.bat)
----------------------------------------------------------------------

 1. Download ZXPSignCmd for Windows:
      https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
    (Direct: ZXPSignCmd-64.exe — rename it to ZXPSignCmd.exe and place
    it next to build.bat, or add its folder to PATH.)
 2. Double-click build.bat. It will:
      - stage a clean copy of the extension into build\stage\
      - generate a self-signed certificate (first run only) at
        build\cinemafx-selfsigned.p12  (password: cinemafx2026 —
        change CERT_* placeholders inside build.bat)
      - sign and package everything into LumaGrain.zxp
 3. Install the resulting LumaGrain.zxp with any ZXP installer
    (Option A above).

 build.sh is the identical flow for Git Bash users.

----------------------------------------------------------------------
 TROUBLESHOOTING
----------------------------------------------------------------------

 Panel does not appear in the Window > Extensions menu
   - Confirm the folder layout: the extension folder must directly
     contain CSXS\manifest.xml.
   - Restart Premiere AFTER copying files.
   - Install the Microsoft Visual C++ Redistributable for CEP
     (Visual Studio 2015 runtime) if extensions never appear.

 Status bar shows "Could not reach the ExtendScript host..."
   - The host script (jsx/hostscript.jsx) failed to load; reopen the
     panel (Window > Extensions > LumaGrain) so CSXS can re-inject it.

 "No clips selected" although clips are selected
   - Click once INTO the timeline panel first (focus must be on the
     sequence), then press Apply.

 Effects added but parameters look default
   - Premiere only exposes localized effect names on some installs;
     the panel resolves effects by both internal matchName and
     English names, so this should not occur. If it does, make sure
     your Premiere language is English or update the name lists in
     jsx/hostscript.jsx (_cfx_getQeEffect candidates).

 Bloom uses the fallback rig and warns about VR Glow
   - Your Premiere build lacks the VR Glow effect (very old builds
     only). The fallback Fast Blur + Screen rig is applied instead.

----------------------------------------------------------------------
 FILE MAP
----------------------------------------------------------------------
  manifest.xml        Documentation copy of the manifest (see CSXS\)
  CSXS\manifest.xml   Canonical CEP manifest (Premiere 2026 / CSXS 12)
  index.html          Panel UI
  style.css           Blue-accent theme
  main.js             Panel logic + JS <-> ExtendScript bridge
  jsx\hostscript.jsx  Effect engine (QE DOM + official DOM)
  lib\CSInterface.js  Adobe's official CEP bridge library (v12)
  build.bat           Windows ZXP build (sign + package)
  build.sh            Bash variant of build.bat
  .debug              Remote-debug port for development
  README.txt          This file

======================================================================
