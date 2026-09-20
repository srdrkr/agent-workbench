import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Probe, assignment, routinePrompt } from './probe.js';
import { githubReader, repositoryPreflight } from './providers.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function secret(path) {
  if (!path || !isAbsolute(path)) throw new Error('Use an absolute credential-file path outside the repository');
  const actual = realpathSync(path);
  const rel = relative(repositoryRoot, actual);
  if (!(rel.startsWith('../') || isAbsolute(rel))) throw new Error('Credential files must be outside the repository');
  const info = statSync(actual);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 4096) throw new Error('Credential file must be private (mode 600) and at most 4096 bytes');
  const value = readFileSync(actual, 'utf8').trim();
  if (!value || /\s/.test(value)) throw new Error('Invalid credential file');
  return value;
}

let probe;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string', default: '.runtime/probe.sqlite' },
    'token-file': { type: 'string' }, 'github-token-file': { type: 'string' },
    live: { type: 'boolean', default: false },
  } });
  const [command, idOrPath, file] = positionals;
  if (!['prepare', 'authorize', 'dispatch', 'status', 'reconcile', 'stop', 'observe-session', 'release', 'payload', 'routine-prompt'].includes(command)) {
    throw new Error('Commands: prepare SPEC | authorize TASK APPROVAL | payload TASK | routine-prompt TASK | dispatch TASK --live --token-file PATH --github-token-file PATH | status TASK | reconcile TASK --github-token-file PATH | stop | observe-session TASK OBSERVATION | release TASK. Optional: --db PATH');
  }
  process.umask(0o077);
  probe = new Probe(values.db);
  let result;
  switch (command) {
    case 'prepare': result = probe.prepare(json(idOrPath)); break;
    case 'authorize': result = probe.authorize(idOrPath, json(file)); break;
    case 'payload': result = JSON.parse(assignment(probe.get(idOrPath))); break;
    case 'routine-prompt': result = routinePrompt(probe.get(idOrPath)); break;
    case 'dispatch': {
      const task = probe.get(idOrPath);
      if (task.dispatch !== 'not_sent') { result = task; break; }
      if (!values.live || task.spec.mode !== 'live') throw new Error('Live dispatch requires a live task and --live');
      // Read-only preflight precedes dispatch intent. No credential enters assignment or worker environment.
      const read = githubReader(task.spec.visibility === 'public' ? undefined : secret(values['github-token-file']));
      await repositoryPreflight(task.spec, read);
      result = await probe.dispatch(idOrPath, { token: secret(values['token-file']) }); break;
    }
    case 'reconcile': result = await probe.reconcile(idOrPath, githubReader(probe.get(idOrPath).spec.visibility === 'public' ? undefined : secret(values['github-token-file']))); break;
    case 'status': result = { task: probe.get(idOrPath), control: probe.controls(), events: probe.history(idOrPath) }; break;
    case 'stop': result = probe.stop(); break;
    case 'observe-session': result = probe.observeSession(idOrPath, json(file)); break;
    case 'release': result = probe.release(idOrPath); break;
  }
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  // File-system and parser errors may contain private paths or file contents.
  const known = error instanceof Error && !error.code && !(error instanceof SyntaxError) && !(error instanceof TypeError);
  console.error(known ? error.message : 'Probe command failed; check local inputs and private file permissions');
  process.exitCode = 1;
} finally { probe?.close(); }
