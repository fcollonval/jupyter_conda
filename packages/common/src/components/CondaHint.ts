import CodeMirror, { Editor } from 'codemirror';
import 'codemirror/addon/hint/show-hint';
import 'codemirror/addon/hint/show-hint.css';

function getChannels(environment_yml: string) {
  const matches = [
    ...environment_yml.matchAll(/^channels:\s*\n((?:\s+- \S+\s*\n)+)\S/gm)
  ];
  if (!matches[0] || matches[0].length < 2) {
    return;
  }
  const channels = matches[0][1];
  if (!channels) {
    return;
  }
  return channels
    .split('\n')
    .filter(x => x)
    .map(line => line.match(/\s+- (.+)\s*/)[1]);
}

function getDependencies(environment_yml: string) {
  const matches = [
    ...environment_yml.matchAll(/^dependencies:\s*\n((?:\s+- .*(\n|$))+)/gm)
  ];
  if (!matches[0] || matches[0].length < 2) {
    return;
  }
  const dependencies = matches[0][1];
  if (!dependencies) {
    return;
  }
  return dependencies
    .split('\n')
    .filter(x => x)
    .map(line => line.match(/\s+- (.+)/)[1]);
}

export function getName(environment_yml: string): string | null {
  const matches = [...environment_yml.matchAll(/^name:\s*(.*?)\s*(?:\n|$)/gm)];
  if (!matches[0] || matches[0].length < 2) {
    return;
  }
  return matches[0][1];
}

async function loadChannels(quetzUrl: string): Promise<string[]> {
  const response = await fetch(`${quetzUrl}/api/channels`);
  if (response.status !== 200) {
    throw new Error(`Unexpected status code: ${response.status}`);
  }
  const data: { name: string }[] = await response.json();
  return data.map(channel => channel.name);
}

type PackageList = { result: { name: string; summary: string }[] };

async function loadPackages(
  quetzUrl: string,
  channel: string,
  q: string
): Promise<PackageList> {
  const response = await fetch(
    `${quetzUrl}/api/paginated/channels/${channel}/packages?limit=20${
      q ? `&q=${q}` : ''
    }`
  );
  if (response.status !== 200) {
    throw new Error(`Unexpected status code: ${response.status}`);
  }
  return response.json();
}

async function loadPackagesOfChannels(
  quetzUrl: string,
  channels: string[],
  q: string
) {
  const data: PackageList[] = await Promise.all(
    channels.map(channel => loadPackages(quetzUrl, channel, q))
  );
  const mapping = data
    .map((d, i) =>
      d.result.map(packageInfo => ({ ...packageInfo, channel: channels[i] }))
    )
    .flat();
  return mapping;
}

async function loadVersions(
  quetzUrl: string,
  channel: string,
  packageName: string
) {
  const url = `${quetzUrl}/api/channels/${channel}/packages/${packageName}/versions`;
  const response = await fetch(url);
  if (response.status === 404) {
    return [];
  }
  if (response.status === 200) {
    return response.json();
  }
  throw new Error(`Unexpected status code: ${response.status}`);
}

async function loadVersionsOfChannels(
  quetzUrl: string,
  channels: string[],
  packageName: string,
  q: string
) {
  const data: { version: string }[][] = await Promise.all(
    channels.map(channel => loadVersions(quetzUrl, channel, packageName))
  );
  const seen: any = {};
  const mapping = data
    .map((d, i) => d.map(version => version.version))
    .flat()
    .filter(e => !q || e.startsWith(q))
    .filter(e => (seen[e] ? false : (seen[e] = true)));
  return mapping;
}

export function register(quetzUrl: string): void {
  const condaHint = async (editor: Editor, callback: any, options: any) => {
    const topLevel = [
      {
        displayText: 'name',
        text: 'name: '
      },
      {
        displayText: 'channels',
        text: 'channels:\n\t- '
      },
      {
        displayText: 'dependencies',
        text: 'dependencies:\n\t- '
      }
    ];

    const cur = editor.getCursor();
    const curLine = editor.getLine(cur.line);

    let list = [];
    let start = 0;

    if (!curLine.startsWith(' ') && !curLine.startsWith('\t')) {
      list = topLevel.filter(e => e.displayText.startsWith(curLine));
      callback({
        list: list,
        from: CodeMirror.Pos(cur.line, start),
        to: CodeMirror.Pos(cur.line, cur.ch)
      });
      return;
    }

    let top = undefined;
    let lineNr = cur.line;
    do {
      lineNr -= 1;
      top = editor.getLine(lineNr);
    } while (top !== undefined && !top.match(/^\S/));

    const wrapErrorMsg = (errorMsg: string) => [
      { displayText: errorMsg, text: '' },
      ''
    ];

    if (top === 'channels:') {
      const re = /^(\s+- )(.*)/;
      const groups = curLine.match(re);
      if (groups && groups.length > 1) {
        const [, pre, name] = groups;
        start = pre.length;
        try {
          list = (await loadChannels(quetzUrl)).filter(channel =>
            channel.startsWith(name || '')
          );
        } catch (e) {
          console.error(e);
          list = wrapErrorMsg('Loading of channels failed');
        }

        callback({
          list: list,
          from: CodeMirror.Pos(cur.line, start),
          to: CodeMirror.Pos(cur.line, cur.ch)
        });
      }
      return;
    }

    if (top === 'dependencies:') {
      const re = /^(?<pre>\s+- )(?<packageName>.+?)?(?<comp1>$|[\s>=<]+)(?<version1>.*?)?(?<comp2>$|[\s,>=<]+)(?<version2>.+?)?($|\s*$)/g;

      const groups = [...curLine.matchAll(re)];

      if (groups && groups.length > 0) {
        const {
          pre,
          packageName,
          comp1,
          version1,
          comp2,
          version2
        } = groups[0].groups;

        const matchLengths = [
          pre,
          packageName,
          comp1,
          version1,
          comp2,
          version2
        ]
          .map(e => (e !== undefined ? e.length : 0))
          .reduce(
            (list, e) =>
              list.length ? [...list, list[list.length - 1] + e] : [e],
            [] as number[]
          );

        const [
          preEnd,
          packageEnd,
          comp1End,
          version1End,
          comp2End,
          version2End
        ] = matchLengths;

        const loadVersions = async (query: string) => {
          try {
            return await loadVersionsOfChannels(
              quetzUrl,
              getChannels(editor.getValue()),
              packageName,
              query
            );
          } catch (e) {
            console.error(e);
            return wrapErrorMsg('Loading of versions failed');
          }
        };

        if (
          cur.ch >= preEnd &&
          (!packageEnd || cur.ch <= packageEnd) /* package */
        ) {
          const packagePart = packageName
            ? packageName.slice(0, cur.ch - preEnd)
            : undefined;

          try {
            list = (
              await loadPackagesOfChannels(
                quetzUrl,
                getChannels(editor.getValue()),
                packagePart
              )
            ).map(p => ({
              displayText: `${p.name} [${p.channel}] ${p.summary}`,
              text: `${p.name}`
            }));
          } catch (e) {
            console.error(e);
            list = wrapErrorMsg('Loading of packages failed');
          }

          callback({
            list: list,
            from: CodeMirror.Pos(cur.line, preEnd),
            to: CodeMirror.Pos(cur.line, packageName ? packageEnd : preEnd)
          });
        } else if (
          cur.ch >= comp1End &&
          (!version1End || cur.ch <= version1End) /* version1 */
        ) {
          list = await loadVersions(version1);
          callback({
            list: list,
            from: CodeMirror.Pos(cur.line, comp1End),
            to: CodeMirror.Pos(cur.line, version1 ? version1End : comp1End)
          });
        } else if (
          cur.ch >= comp2End &&
          (!version2End || cur.ch <= version2End) /* version2 */
        ) {
          list = await loadVersions(version2);
          callback({
            list: list,
            from: CodeMirror.Pos(cur.line, comp2End),
            to: CodeMirror.Pos(cur.line, version2 ? version2End : comp2End)
          });
        }
      }
    }
  };
  condaHint.async = true;
  CodeMirror.registerHelper('hint', 'yaml', condaHint);
}

export async function fetchSolve(
  quetzUrl: string,
  quetzSolverUrl: string,
  subdir: string,
  environment_yml: string
): Promise<string> {
  const data = {
    subdir,
    channels: getChannels(environment_yml).map(
      channel => `${quetzUrl}/get/${channel}`
    ),
    spec: getDependencies(environment_yml)
  };
  const response = await fetch(
    `${quetzSolverUrl || quetzUrl}/api/mamba/solve`,
    {
      method: 'POST',
      body: JSON.stringify(data)
    }
  );
  if (response.status === 200) {
    return response.text();
  } else {
    throw Error(`error [${response.status}]`);
  }
}
