/**
 * Bash「只读命令」判定。
 *
 * 目的：ls / cat / grep / git status 这类不改动任何东西的命令不再弹审批。
 * 判定不了的一律返回不可放行，落回人工审批——宁可多问一次，也不要放行一条没看懂的命令。
 *
 * 这不是沙箱：路径围栏和审批依然是兜底，这一层只负责少打扰。
 */

/** 确认只读、只往 stdout 写的基础命令 */
const READ_ONLY_COMMANDS = new Set([
  // 文件/目录查看
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'tree',
  'pwd', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'whereis', 'type',
  // 文本检索与处理
  'grep', 'egrep', 'fgrep', 'rg', 'fd', 'find', 'sort', 'uniq', 'cut', 'tr',
  'nl', 'column', 'diff', 'cmp', 'comm', 'jq', 'yq',
  // 纯输出
  'echo', 'printf',
  // 只改当前 shell 的工作目录；后续命令各自独立判定
  'cd',
  // 系统信息
  'uname', 'hostname', 'whoami', 'id', 'date', 'ps', 'uptime',
  'shasum', 'md5sum', 'sha1sum', 'sha256sum', 'cksum',
  // 版本控制 / 包管理（子命令交给下面的专门规则再校验）
  'git', 'npm', 'pnpm', 'yarn',
]);

/** 这些命令本身只读，但部分参数会写文件或执行外部程序 */
const DENY_FLAGS = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  fd: ['-x', '--exec', '-X', '--exec-batch'],
  rg: ['--pre', '--pre-glob', '--hostname-bin'],
  tree: ['-o'],
  sort: ['-o', '--output', '--compress-program'],
  yq: ['-i', '--inplace'],
  tail: ['-f', '-F', '--follow'],
};

/** git 里明确只读的子命令 */
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'shortlog', 'describe', 'whatchanged',
  'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'grep',
  'name-rev', 'merge-base', 'show-ref', 'for-each-ref', 'version', 'help',
]);

/** git 里会写文件 / 起外部程序的参数，任何子命令下都拒绝 */
const GIT_ARG_DENY = ['--output', '-O', '--ext-diff', '--open-files-in-pager'];

/** git branch 的写操作开关（注意 branch 的 -a 是「列出全部」，不是 annotate） */
const GIT_BRANCH_WRITE_FLAGS = [
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force',
  '-u', '--set-upstream-to', '--unset-upstream', '--edit-description',
  '--track', '--no-track', '-e', '--edit', '--create-reflog',
];

/** git tag 的写操作开关 */
const GIT_TAG_WRITE_FLAGS = [
  '-d', '--delete', '-a', '--annotate', '-s', '--sign', '-u', '--local-user',
  '-f', '--force', '-m', '-F', '--file', '-e', '--edit', '--cleanup',
];

/** 带这些参数时，位置参数是过滤条件而不是新建分支/标签 */
const GIT_REF_LIST_FLAGS = [
  '-l', '--list', '--contains', '--points-at', '--merged', '--no-merged', '--sort', '--format',
];

const GIT_CONFIG_READ_FLAGS = ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--name-only'];
const GIT_CONFIG_WRITE_FLAGS = ['--add', '--unset', '--unset-all', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section'];

const PKG_READ_SUBCOMMANDS = new Set(['ls', 'list', 'view', 'info', 'show', 'outdated', 'why', 'root', 'prefix']);

const allow = () => ({ readOnly: true });
const reject = (reason) => ({ readOnly: false, reason });

/**
 * 按顶层操作符切成若干条简单命令，同时挡掉重定向、子 shell、命令替换这类
 * 会绕开「单条命令只读」假设的写法。
 */
function splitSegments(command) {
  const segments = [];
  let cur = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"') {
        cur += command[++i] ?? '';
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '\\') {
      cur += ch + (command[++i] ?? '');
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '>' || ch === '<' || ch === '(' || ch === ')') {
      return { error: `包含重定向或子 shell 语法 "${ch}"` };
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      segments.push(cur);
      cur = '';
      // && 和 || 是两个字符，跳过第二个
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }

  if (quote) return { error: '引号未闭合' };
  segments.push(cur);

  return { segments: segments.map((s) => s.trim()).filter(Boolean) };
}

/** 把一条简单命令切成 token，拒绝变量展开和命令替换 */
function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let has = false;

  const finish = () => {
    if (has) {
      tokens.push(cur);
      cur = '';
      has = false;
    }
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      has = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        cur += segment[++i] ?? '';
      } else if (ch === '$' || ch === '`') {
        return { error: '包含变量展开或命令替换' };
      } else {
        cur += ch;
      }
      has = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\') {
      cur += segment[++i] ?? '';
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      finish();
      continue;
    }
    if (ch === '$' || ch === '`') return { error: '包含变量展开或命令替换' };
    if (ch === '#' && !has) break; // 行尾注释
    cur += ch;
    has = true;
  }

  if (quote) return { error: '引号未闭合' };
  finish();
  return { tokens };
}

function findDeniedFlag(cmd, args) {
  const denyList = DENY_FLAGS[cmd] ?? [];
  for (const arg of args) {
    for (const flag of denyList) {
      if (arg === flag || (flag.startsWith('--') && arg.startsWith(`${flag}=`))) return arg;
    }
  }

  // 组合短选项里藏着的写文件开关：sort -ro out、tree -ao out
  if ((cmd === 'sort' || cmd === 'tree') && args.some((a) => /^-([A-Za-z]*)o[A-Za-z]*$/.test(a))) {
    return '组合选项里的 -o';
  }
  // tail -nf 10 里的 f
  if (cmd === 'tail' && args.some((a) => /^-[A-Za-z]*[fF][A-Za-z]*$/.test(a))) {
    return '跟随模式';
  }
  return null;
}

function checkRefListing(sub, args) {
  const writeFlags = sub === 'tag' ? GIT_TAG_WRITE_FLAGS : GIT_BRANCH_WRITE_FLAGS;
  const write = args.find((a) => writeFlags.includes(a));
  if (write) return reject(`git ${sub} 参数 ${write} 会修改引用`);

  const hasListFlag = args.some((a) => GIT_REF_LIST_FLAGS.includes(a));
  const hasPositional = args.some((a) => !a.startsWith('-'));
  if (hasPositional && !hasListFlag) return reject(`没有 --list 时位置参数会新建 ${sub}`);
  return allow();
}

function classifyGit(args) {
  const denied = args.find(
    (a) => GIT_ARG_DENY.includes(a) || a.startsWith('--output='),
  );
  if (denied) return reject(`git 参数 ${denied} 会写文件或执行外部程序`);

  // 跳过 -C <dir> / --git-dir=... 这类全局选项
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      i += 2;
      continue;
    }
    if (a === '--no-pager') {
      i += 1;
      continue;
    }
    if (a === '-c') return reject('git -c 可以注入配置，不放行');
    if (a.startsWith('-')) return reject(`git 全局选项 ${a} 未放行`);
    break;
  }

  const sub = args[i];
  if (!sub) return reject('缺少 git 子命令');
  const rest = args.slice(i + 1);

  if (GIT_READ_SUBCOMMANDS.has(sub)) return allow();

  switch (sub) {
    case 'branch':
    case 'tag':
      return checkRefListing(sub, rest);

    case 'config': {
      const write = rest.find((a) => GIT_CONFIG_WRITE_FLAGS.includes(a));
      if (write) return reject(`git config ${write} 会改配置`);
      // 只读查询：git config <key> / git config --get <key> / git config --list
      if (rest.some((a) => GIT_CONFIG_READ_FLAGS.includes(a))) return allow();
      const positional = rest.filter((a) => !a.startsWith('-'));
      return positional.length === 1
        ? allow()
        : reject('git config 只放行读操作（--get / --list / 只查一个 key）');
    }

    case 'remote':
      return rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0])
        ? allow()
        : reject(`git remote ${rest[0]} 会修改远端配置`);

    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show'
        ? allow()
        : reject('只放行 git stash list / show');

    case 'reflog':
      return rest.length === 0 || rest[0] === 'show'
        ? allow()
        : reject(`git reflog ${rest[0]} 不是只读操作`);

    case 'worktree':
      return rest.length === 0 || rest[0] === 'list'
        ? allow()
        : reject('只放行 git worktree list');

    case 'submodule':
      return rest.length === 0 || rest[0] === 'status' || rest[0] === 'summary'
        ? allow()
        : reject('只放行 git submodule status / summary');

    default:
      return reject(`git ${sub} 可能修改仓库`);
  }
}

function classifyPackageManager(cmd, args) {
  if (args.length === 0) return reject(`${cmd} 缺少子命令`);
  const sub = args[0];

  if ((sub === '--version' || sub === '-v') && args.length === 1) return allow();
  // 不带参数的 npm version 只打印版本；带参数会改 package.json
  if (sub === 'version' && args.length === 1) return allow();

  if (!PKG_READ_SUBCOMMANDS.has(sub)) return reject(`${cmd} ${sub} 可能修改文件`);
  return allow();
}

function classify(tokens) {
  const [cmd, ...args] = tokens;
  if (!cmd) return reject('空命令');

  if (!READ_ONLY_COMMANDS.has(cmd)) return reject(`未识别的命令 ${cmd}`);

  const denied = findDeniedFlag(cmd, args);
  if (denied) return reject(`${cmd} 的 ${denied} 参数可能写文件`);

  if (cmd === 'git') return classifyGit(args);
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') return classifyPackageManager(cmd, args);

  return allow();
}

/**
 * 判断一条 Bash 命令是否纯只读。
 *
 * @param {string} command
 * @returns {{ readOnly: boolean, reason?: string }}
 */
export function analyzeBashCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return reject('空命令');
  }

  const split = splitSegments(command);
  if (split.error) return reject(split.error);

  for (const segment of split.segments) {
    const tokenized = tokenize(segment);
    if (tokenized.error) return reject(tokenized.error);

    const verdict = classify(tokenized.tokens);
    if (!verdict.readOnly) {
      return reject(`${segment}：${verdict.reason}`);
    }
  }

  return allow();
}
