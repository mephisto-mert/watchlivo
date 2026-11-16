import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('M2: CSS fixes in vortex.css and mesh.css', () => {
  const vortexCss = fs.readFileSync(path.join(rootDir, 'static/css/vortex.css'), 'utf-8');
  assert.match(
    vortexCss,
    /\.popup,\s*\.modal,\s*\.modal-backdrop,\s*\.legal-modal,\s*\.about-content,\s*\.toast-content,\s*\.log-container\s*\{\s*user-select:\s*text;\s*-webkit-user-select:\s*text;\s*\}/,
    'vortex.css must have user-select: text on dialog elements'
  );

  const meshCss = fs.readFileSync(path.join(rootDir, 'static/css/mesh.css'), 'utf-8');
  assert.match(
    meshCss,
    /@media\s*\(max-width:\s*900px\),\s*\(pointer:\s*coarse\)/,
    'mesh.css must align mobile breakpoint to max-width: 900px'
  );
});

test('M2: Controls keydown guards and aria attributes in controls.js', () => {
  const controlsJs = fs.readFileSync(path.join(rootDir, 'static/js/views/controls.js'), 'utf-8');

  // Input exclusion includes tag === 'select'
  assert.match(
    controlsJs,
    /tag\s*===\s*'select'/,
    'onKeyDown must exclude select elements from key hijacking'
  );

  // ArrowLeft / ArrowRight guarded on button and select
  assert.match(
    controlsJs,
    /if\s*\(\s*tag\s*===\s*'button'\s*\|\|\s*tag\s*===\s*'select'\s*\)\s*return;/,
    'ArrowLeft and ArrowRight seek handlers must guard button and select'
  );

  // Redundant if (true) removed
  assert.doesNotMatch(
    controlsJs,
    /if\s*\(\s*true\s*\)\s*\{\s*m\.url\s*=\s*fresh\.url;/,
    'Redundant if (true) must be removed around line 1831'
  );

  // Stream switching URL query string handles ? and &
  assert.match(
    controlsJs,
    /const\s+delim\s*=\s*nextSrvUrl\.includes\('\?'\)\s*\?\s*'&'\s*:\s*'\?';/,
    'Stream switching URL must dynamically pick ? or &'
  );

  // Timeline slider aria-valuetext initialization
  assert.match(
    controlsJs,
    /'aria-valuetext':\s*'0:00 \/ 0:00'/,
    'Timeline slider must include initial aria-valuetext'
  );

  // Dual subtitle cue rendering
  assert.match(
    controlsJs,
    /if\s*\(secondaryTxt\)\s*\{\s*dualCue\.textContent\s*=\s*secondaryTxt;\s*dualCue\.classList\.remove\('hidden'\);/,
    'dualCue must be populated and shown when secondary subtitle is present'
  );
});

test('M2: Subtitles setDualSubtitle and _syncSecondaryDualTrack in subtitles.js', async () => {
  const subtitlesJs = fs.readFileSync(path.join(rootDir, 'static/js/players/subtitles.js'), 'utf-8');
  assert.match(
    subtitlesJs,
    /async\s+setDualSubtitle\(subId\)/,
    'setDualSubtitle must take subId parameter'
  );
  assert.match(
    subtitlesJs,
    /this\.dualSubEnabled\s*=\s*true;/,
    'setDualSubtitle must set dualSubEnabled = true on successful cue load'
  );
});

test('M2: Chat ArrowUp keydown behavior in chat.js', () => {
  const chatJs = fs.readFileSync(path.join(rootDir, 'static/js/views/chat.js'), 'utf-8');
  assert.doesNotMatch(
    chatJs,
    /if\s*\(e\.key\s*===\s*'ArrowUp'\s*&&\s*input\.value\.length\s*>\s*0\)/,
    'Unconditional e.preventDefault on ArrowUp must be removed from chat input'
  );
});

test('M2: TV spatial navigation and error boundary in main.js', () => {
  const mainJs = fs.readFileSync(path.join(rootDir, 'static/js/main.js'), 'utf-8');
  // Range not in button/checkbox/radio
  assert.match(
    mainJs,
    /!\[\s*'button',\s*'checkbox',\s*'radio'\s*\]\.includes\(active\.type\)/,
    'Range sliders must not be excluded from spatial navigation text input guard'
  );
  assert.match(
    mainJs,
    /active\.tagName\s*===\s*'SELECT'/,
    'Select dropdowns must be guarded in spatial navigation'
  );

  // Global unhandled error boundary
  assert.match(
    mainJs,
    /window\.addEventListener\('unhandledrejection'/,
    'main.js must register unhandledrejection listener'
  );
  assert.match(
    mainJs,
    /window\.onerror\s*=/,
    'main.js must define window.onerror handler'
  );
});

test('M2: Chat resizer accessibility and keyboard support in mesh-layout.js', () => {
  const meshLayoutJs = fs.readFileSync(path.join(rootDir, 'static/js/views/mesh-layout.js'), 'utf-8');
  assert.match(
    meshLayoutJs,
    /role:\s*'separator'/,
    'Resize handle must have role: separator'
  );
  assert.match(
    meshLayoutJs,
    /tabindex:\s*'0'/,
    'Resize handle must have tabindex: 0'
  );
  assert.match(
    meshLayoutJs,
    /'aria-orientation':\s*'vertical'/,
    'Resize handle must have aria-orientation: vertical'
  );
  assert.match(
    meshLayoutJs,
    /'aria-label':\s*'Sohbet paneli boyutlandırıcı'/,
    'Resize handle must have Turkish aria-label'
  );

  // Keyboard navigation on resize handle
  assert.match(
    meshLayoutJs,
    /handle\.addEventListener\('keydown'/,
    'Resize handle must attach keydown listener'
  );
});

test('M2: NTP clock convergence guard in sync.js', () => {
  const syncJs = fs.readFileSync(path.join(rootDir, 'static/js/sync.js'), 'utf-8');
  assert.match(
    syncJs,
    /this\.clock\s*=\s*syncClock\s*\|\|\s*clock;/,
    'SyncEngine must bind this.clock'
  );
  assert.match(
    syncJs,
    /if\s*\(abs\s*<\s*4\.0\s*&&\s*\(this\.clock\?\.samples\s*\|\|\s*0\)\s*<\s*4\)\s*\{\s*return\s*600;\s*\}/,
    'Initial sync must guard small drift jumps when NTP clock samples < 4'
  );
  assert.match(
    syncJs,
    /const\s+allowDriftJump\s*=\s*abs\s*>=\s*4\.0\s*\|\|\s*\(this\.clock\?\.samples\s*\|\|\s*0\)\s*>=\s*4;/,
    'Steady-state drift jump must require clock.samples >= 4 for drifts < 4.0s'
  );
});
