import * as React from 'react';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import './yaml';
import * as condaHint from './CondaHint';

/**
 * Conda solve properties
 */
export interface ICondaEnvSolveProps {
  quetzUrl: string;
  quetzSolverUrl: string;
  subdir: string;
  create(name: string, explicitList: string): void;
}

export const CondaEnvSolve = (props: ICondaEnvSolveProps): JSX.Element => {
  condaHint.register(props.quetzUrl);

  const codemirrorElem = React.useRef();

  const [editor, setEditor] = React.useState(null);
  const [solveState, setSolveState] = React.useState(null);

  async function solve() {
    const environment_yml = editor.getValue();
    setSolveState('Solving...');
    const name = condaHint.getName(environment_yml);
    try {
      const solveResult = await condaHint.fetchSolve(
        props.quetzUrl,
        props.quetzSolverUrl,
        props.subdir,
        environment_yml
      );
      setSolveState(`Creating environment ${name}...`);
      await props.create(name, solveResult);
      setSolveState('Ok');
    } catch (e) {
      setSolveState(`Error: ${e}`);
    }
  }

  React.useEffect(() => {
    if (editor) {
      return;
    }
    setEditor(
      CodeMirror(codemirrorElem.current, {
        lineNumbers: true,
        extraKeys: {
          'Ctrl-Space': 'autocomplete',
          'Ctrl-Tab': 'autocomplete'
        },
        tabSize: 2,
        mode: 'yaml',
        autofocus: true
      })
    );
  });
  return (
    <div style={{ width: '80vw', maxWidth: '900px' }}>
      <div ref={codemirrorElem}></div>
      <div style={{ paddingTop: '8px' }}>
        <button onClick={solve}>Create</button>
        <span style={{ marginLeft: '16px' }}>{solveState}</span>
      </div>
    </div>
  );
};
