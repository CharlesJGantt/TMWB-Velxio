/**
 * EmbedPage — route `/embed`.
 *
 * A deliberately minimal editor shell meant to sit inside an <iframe> in a
 * CMS post (see the TMWB Drupal module). Unlike EditorPage, this has no
 * AppHeader, no GitHub star / news nagging, no file explorer, no
 * new-project dialog, no auth slot -- just the code editor, the circuit
 * canvas, run controls, and (when opened) the serial monitor. A small
 * attribution bar (required by AGPLv3 -- see LICENSE) doubles as an escape
 * hatch to the full standalone editor.
 *
 * Query params:
 *   ?project=<url>   Fetch a .vlx-shaped JSON from this URL and load it
 *                     (a specific circuit an author built for a tutorial).
 *   ?board=<kind>     No `project`: open a blank board of this kind
 *                     (defaults to 'arduino-uno'). Ignored if `project` is set.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { startSimulation } from '../simulation/spice/start';
import { CodeEditor } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../store/useSimulatorStore';
import { loadProjectFromUrl } from '../utils/loadProjectFromUrl';
import { runEditorCommand } from '../lib/editorCommands';
import { clearWorkspaceForStarter } from '../components/editor/NewProjectDialog';
import type { BoardKind } from '../types/board';
import type { CompilationLog } from '../utils/compilationLogger';
import '../App.css';
import './EmbedPage.css';

const REPO_URL = 'https://github.com/CharlesJGantt/TMWB-Velxio';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Loads the embed's project -- the URL-given .vlx, or a blank board of the
 * given kind. Shared by the mount effect and the Reset button so "go back
 * to what this article embedded" is exactly "do what a fresh page load
 * would do."
 */
async function loadEmbedProject(projectUrl: string | null, boardParam: BoardKind): Promise<void> {
  if (projectUrl) {
    await loadProjectFromUrl(projectUrl);
    return;
  }
  // clearWorkspaceForStarter empties boards/components/wires/file groups --
  // NOT just clearCurrentProject(), which only touches useProjectStore and
  // leaves the store's built-in default LED+resistor demo circuit sitting
  // on the canvas. Unlike the full editor's "New workspace" dialog, an
  // embed's blank board deliberately skips loading the gallery Blink
  // example too: a tutorial embedding a bare board wants an EMPTY canvas
  // to build on, not a pre-wired demo.
  clearWorkspaceForStarter();
  const sim = useSimulatorStore.getState();
  const newId = sim.addBoard(boardParam, DEFAULT_BOARD_POSITION.x, DEFAULT_BOARD_POSITION.y);
  sim.setActiveBoardId(newId);
}

export const EmbedPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const projectUrl = searchParams.get('project');
  const boardParam = (searchParams.get('board') as BoardKind | null) ?? 'arduino-uno';

  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [compileLogs, setCompileLogs] = useState<CompilationLog[]>([]);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);

  useEffect(() => startSimulation(), []);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    loadEmbedProject(projectUrl, boardParam)
      .then(() => {
        if (!cancelled) setState('ready');
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
          setState('error');
        }
      });
    return () => {
      cancelled = true;
    };
    // Only re-run if the params actually change (a new embed on the page,
    // not a re-render from unrelated store updates).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectUrl, boardParam]);

  // Visitors can freely edit code/wiring while playing with a tutorial
  // embed -- nothing persists anyway (OSS has no server-side save, and an
  // anonymous per-visitor save wouldn't make sense for a public article).
  // This just re-runs the same load a fresh page view would do, so a
  // visitor who's made a mess can get back to the article's circuit
  // without reloading the whole iframe.
  const [resetting, setResetting] = useState(false);
  const handleReset = async () => {
    if (!window.confirm('Reset to the original circuit? Your changes here will be lost.')) return;
    setResetting(true);
    try {
      await loadEmbedProject(projectUrl, boardParam);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setState('error');
    } finally {
      setResetting(false);
    }
  };

  // Export/Import are pure client-side (file download / native file picker
  // via the hidden <input> EditorToolbar already renders) -- no backend, no
  // account, so they're safe to expose directly in a public embed. Reusing
  // the same commands the full editor's File menu calls means there's only
  // one implementation of "what does export/import actually do."
  const handleExport = () => runEditorCommand('project.exportVlx');
  const handleImport = () => runEditorCommand('project.import');

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = '';
      body.style.overflow = '';
    };
  }, []);

  const openInFullEditorHref = projectUrl
    ? `/editor?project=${encodeURIComponent(projectUrl)}`
    : `/example/blink-led`;

  if (state === 'error') {
    return (
      <div className="embed-shell embed-shell--error">
        <p>Couldn't load this circuit: {errorMessage}</p>
      </div>
    );
  }

  return (
    <div className="embed-shell">
      <div className="embed-toolbar-row">
        <EditorToolbar
          consoleOpen={consoleOpen}
          setConsoleOpen={setConsoleOpen}
          compileLogs={compileLogs}
          setCompileLogs={setCompileLogs}
        />
      </div>
      <div className="embed-main">
        <div className="embed-code-pane">
          <CodeEditor />
        </div>
        <div className="embed-canvas-pane">
          <SimulatorCanvas />
        </div>
      </div>
      {serialMonitorOpen && (
        <div className="embed-serial-pane">
          <SerialMonitor />
        </div>
      )}
      <div className="embed-attribution">
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Powered by Velxio
        </a>
        <div className="embed-attribution-actions">
          <button type="button" className="embed-action-button" onClick={handleImport}>
            Import
          </button>
          <button type="button" className="embed-action-button" onClick={handleExport}>
            Export (.vlx)
          </button>
          <button
            type="button"
            className="embed-action-button"
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? 'Resetting…' : 'Reset circuit'}
          </button>
        </div>
        <a href={openInFullEditorHref} target="_blank" rel="noopener noreferrer">
          Open in full editor ↗
        </a>
      </div>
    </div>
  );
};
