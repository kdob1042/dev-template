const PROJECT_QUERY = [
  'query($login:String!, $number:Int!) {',
  '  user(login:$login) { projectV2(number:$number) { id viewerCanUpdate',
  '    fields(first:100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }',
  '  } }',
  '}'
].join('\n');

const ITEMS_QUERY = [
  'query($id:ID!, $cursor:String) {',
  '  node(id:$id) { ... on ProjectV2 { items(first:100, after:$cursor) {',
  '    nodes { id isArchived fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }',
  '      content { __typename ... on Issue { id number repository { nameWithOwner } } }',
  '    } pageInfo { hasNextPage endCursor }',
  '  } } }',
  '}'
].join('\n');

const STATUS_NAMES = ['Todo', 'In Progress', 'Needs attention', 'Done'];
const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const DEFAULT_ACTIVATED_AFTER = '2026-09-17T00:00:00Z';

function settingsFor(context) {
  const repository = context.payload?.repository || {};
  const projectNumber = Number(process.env.PROJECT_NUMBER || '1');
  if (!Number.isSafeInteger(projectNumber) || projectNumber < 1) {
    throw new Error('PROJECT_NUMBER must be a positive integer.');
  }
  return {
    projectOwner: process.env.PROJECT_OWNER || context.repo.owner,
    projectNumber,
    workBranch: process.env.WORK_BRANCH || 'dev',
    defaultBranch: repository.default_branch || process.env.DEFAULT_BRANCH || 'main',
    ciName: (process.env.PROJECT_SYNC_CI_NAME || '').trim(),
    activatedAfter: process.env.AUTOMATION_ACTIVATED_AFTER ||
      repository.created_at || DEFAULT_ACTIVATED_AFTER
  };
}

function stripControl(body = '') {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(new RegExp('\\x60\\x60\\x60[\\s\\S]*?\\x60\\x60\\x60|~~~[\\s\\S]*?~~~', 'g'), '');
}

// One explicit reference per line; prose, examples and cross-repository links are not commands.
function references(body = '', fullName) {
  const refs = new Map();
  const clean = stripControl(body);
  for (const line of clean.split('\n')) {
    const match = line.match(/^\s*(?:[-*]\s+)?(refs?|close[sd]?|fix(?:e[sd]?)?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#([1-9]\d*)\s*[.]?\s*$/i);
    if (!match || (match[2] && match[2].toLowerCase() !== fullName.toLowerCase())) continue;
    const number = Number(match[3]);
    refs.set(number, refs.get(number) || !/^refs?$/i.test(match[1]));
  }
  return refs;
}

// A partial implementation is completed by opening a follow-up Issue with this
// exact line. Keeping the marker explicit prevents ordinary prose from closing
// the parent Issue accidentally.
function followUpReferences(body = '', fullName) {
  const refs = new Set();
  for (const line of stripControl(body).split('\n')) {
    const match = line.match(/^\s*(?:parent|follow[- ]?up(?:\s+for)?|continues)\s*:\s*(?:([\w.-]+\/[\w.-]+))?#([1-9]\d*)\s*[.]?\s*$/i);
    if (!match || (match[1] && match[1].toLowerCase() !== fullName.toLowerCase())) continue;
    refs.add(Number(match[2]));
  }
  return refs;
}

function related(pull, number, fullName) {
  // Only trusted same-repository branches can drive a privileged issue transition.
  return Boolean(pull?.head?.repo?.full_name) &&
    pull.head.repo.full_name.toLowerCase() === fullName.toLowerCase() &&
    (references(pull.body, fullName).has(number) || pull.head.ref.startsWith('issue/' + number + '-'));
}

function statusFor(issue, pulls, health) {
  if (issue.state === 'closed') return 'Done';
  const open = pulls.filter(p => p.state === 'open');
  if (open.length) return open.some(p => health.get(p.number)) ? 'Needs attention' : 'In Progress';
  if (pulls.length || issue.labels.some(l => (l.name || l) === 'agent:start')) return 'Needs attention';
  return 'Todo';
}

function completionCandidate(issue, pulls, fullName, hasFollowUp = false, settings = {}) {
  if (issue.state !== 'open' || pulls.some(p => p.state === 'open')) return null;
  const branches = new Set([settings.workBranch || 'dev', settings.defaultBranch || 'main']);
  const activatedAfter = settings.activatedAfter || DEFAULT_ACTIVATED_AFTER;
  return pulls.filter(p => p.merged_at && p.merged_at > activatedAfter &&
    branches.has(p.base?.ref) &&
    (references(p.body, fullName).get(issue.number) ||
      (hasFollowUp && references(p.body, fullName).has(issue.number))))
    .sort((a, b) => b.merged_at.localeCompare(a.merged_at))[0] || null;
}

function failingRuns(runs, sha, ciName) {
  if (!ciName) return false;
  const latest = new Map();
  for (const run of runs || []) {
    if (!run || run.head_sha !== sha || run.name !== ciName) continue;
    const previous = latest.get(run.workflow_id);
    if (!previous || run.id > previous.id || (run.id === previous.id && run.run_attempt > previous.run_attempt)) {
      latest.set(run.workflow_id, run);
    }
  }
  return [...latest.values()].some(run => run.status === 'completed' && BAD.has(run.conclusion));
}

function changesRequested(reviews) {
  const latest = new Map();
  for (const review of reviews || []) {
    if (!review.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    const previous = latest.get(review.user.login);
    if (!previous || review.id > previous.id) latest.set(review.user.login, review);
  }
  return [...latest.values()].some(review => review.state === 'CHANGES_REQUESTED');
}

async function projectAccess(github, settings) {
  const result = await github.graphql(PROJECT_QUERY, {
    login: settings.projectOwner,
    number: settings.projectNumber
  });
  const project = result.user?.projectV2;
  if (!project?.viewerCanUpdate) {
    throw new Error('PROJECTS_TOKEN must have write access to ' +
      settings.projectOwner + ' Project #' + settings.projectNumber + '.');
  }
  const field = project.fields.nodes.find(f => f?.name === 'Status');
  for (const name of STATUS_NAMES) {
    if (!field?.options.some(o => o.name === name)) {
      throw new Error('Project Status option missing: ' + name);
    }
  }
  return { project, field };
}

async function reconcile({ github, context, core, dryRun = false }) {
  const { owner, repo } = context.repo;
  const fullName = owner + '/' + repo;
  const settings = settingsFor(context);
  const { project, field } = await projectAccess(github, settings);
  const items = [];
  let cursor = null;
  do {
    const page = (await github.graphql(ITEMS_QUERY, { id: project.id, cursor })).node.items;
    items.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  const tracked = items.filter(i => i.content?.__typename === 'Issue' &&
    i.content.repository.nameWithOwner.toLowerCase() === fullName.toLowerCase());
  const openIssues = (await github.paginate(github.rest.issues.listForRepo,
    { owner, repo, state: 'open', per_page: 100 })).filter(i => !i.pull_request);
  const followUpsByParent = new Set();
  for (const followUp of openIssues) {
    for (const parent of followUpReferences(followUp.body, fullName)) followUpsByParent.add(parent);
  }
  const numbers = new Set([...openIssues.map(i => i.number), ...tracked.map(i => i.content.number)]);
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', per_page: 100 });
  const health = new Map();
  for (const pull of pulls.filter(p => p?.state === 'open' && p?.head?.sha &&
    p?.head?.repo?.full_name === fullName)) {
    const runs = settings.ciName
      ? await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
        { owner, repo, head_sha: pull.head.sha, per_page: 100 },
        response => response.data.workflow_runs)
      : [];
    const reviews = await github.paginate(github.rest.pulls.listReviews,
      { owner, repo, pull_number: pull.number, per_page: 100 });
    health.set(pull.number, failingRuns(runs, pull.head.sha, settings.ciName) || changesRequested(reviews));
  }
  for (const number of numbers) {
    // Read current state, not an old event payload (queued events may arrive out of order).
    const issue = (await github.rest.issues.get({ owner, repo, issue_number: number })).data;
    if (issue.pull_request) continue;
    const linked = pulls.filter(p => related(p, number, fullName));
    const completion = completionCandidate(issue, linked, fullName,
      followUpsByParent.has(number), settings);
    if (completion) {
      const timeline = await github.paginate(github.rest.issues.listEventsForTimeline,
        { owner, repo, issue_number: number, per_page: 100 });
      const reopened = timeline.some(e => e.event === 'reopened' && e.created_at >= completion.merged_at);
      if (!reopened) {
        const migrated = !references(completion.body, fullName).get(number);
        core.info(fullName + ' #' + number + ': ' +
          (migrated ? 'migrated to follow-up Issue' : 'completed') +
          ' by PR #' + completion.number + (dryRun ? ' (dry run)' : ''));
        if (!dryRun) {
          await github.rest.issues.update({
            owner, repo, issue_number: number, state: 'closed', state_reason: 'completed'
          });
          issue.state = 'closed';
        }
      }
    }
    const desired = statusFor(issue, linked, health);
    let item = tracked.find(i => i.content.id === issue.node_id);
    // Respect deliberately archived cards; do not unarchive or duplicate them.
    if (item?.isArchived) continue;
    if (!item && !dryRun) {
      item = (await github.graphql(
        'mutation($project:ID!, $content:ID!) {' +
        ' addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } } }',
        { project: project.id, content: issue.node_id }
      )).addProjectV2ItemById.item;
    }
    if (item?.fieldValueByName?.name !== desired) {
      core.info(fullName + ' #' + number + ' -> ' + desired + (dryRun ? ' (dry run)' : ''));
      if (!dryRun) {
        await github.graphql(
          'mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {' +
          ' updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field,' +
          ' value:{singleSelectOptionId:$option}}) { projectV2Item { id } } }',
          {
            project: project.id,
            item: item.id,
            field: field.id,
            option: field.options.find(o => o.name === desired).id
          }
        );
      }
    }
    // Remove only obsolete state labels, never replace the entire label collection.
    if (!dryRun) for (const label of issue.labels) {
      const name = label.name || label;
      if (name.startsWith('status:') || name === 'agent:started') {
        try {
          await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
  }
}

async function start({ github, context, core }) {
  const { owner, repo } = context.repo;
  const number = context.payload.issue.number;
  const settings = settingsFor(context);
  if (context.payload.issue.pull_request) return;
  if (context.eventName === 'issue_comment' &&
      !/^\s*\/start\s*$/i.test(context.payload.comment.body)) return;
  if (context.actor.toLowerCase() !== owner.toLowerCase()) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      owner, repo, username: context.actor
    });
    if (!['admin', 'maintain', 'write'].includes(data.permission)) {
      throw new Error('Starting work requires repository write permission.');
    }
  }
  const issue = (await github.rest.issues.get({ owner, repo, issue_number: number })).data;
  if (issue.state !== 'open') return;
  // Check Project access before creating anything. Missing credentials fail loudly.
  await projectAccess(github, settings);
  if (!issue.labels.some(l => (l.name || l) === 'agent:start')) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: ['agent:start'] });
  }
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', per_page: 100 });
  const linked = pulls.filter(p => related(p, number, fullName(owner, repo)));
  if (linked.some(p => p.state === 'open')) {
    await reconcile({ github, context, core });
    return;
  }
  const branch = 'issue/' + number + '-work-' + (linked.length + 1);
  const base = (await github.rest.git.getRef({
    owner, repo, ref: 'heads/' + settings.workBranch
  })).data.object.sha;
  let branchSha;
  try {
    branchSha = (await github.rest.git.getRef({
      owner, repo, ref: 'heads/' + branch
    })).data.object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!branchSha || branchSha === base) {
    const tree = (await github.rest.git.getCommit({
      owner, repo, commit_sha: base
    })).data.tree.sha;
    const sha = (await github.rest.git.createCommit({
      owner, repo, tree, parents: [base], message: 'chore: start issue #' + number
    })).data.sha;
    if (branchSha) {
      await github.rest.git.updateRef({
        owner, repo, ref: 'heads/' + branch, sha, force: false
      });
    } else {
      await github.rest.git.createRef({ owner, repo, ref: 'refs/heads/' + branch, sha });
    }
  }
  const pull = (await github.rest.pulls.create({
    owner,
    repo,
    head: branch,
    base: settings.workBranch,
    draft: true,
    title: 'WIP: #' + number + ' ' + issue.title,
    body: [
      '## Linked issue',
      '',
      'Refs #' + number,
      '',
      '着手用の空Draft PRです。実装はこのブランチ・PRを再利用してください。',
      '受入条件をすべて満たす場合だけ Refs を Closes に変更し、検証後にReady for reviewにします。'
    ].join('\n')
  })).data;
  await github.rest.issues.createComment({
    owner, repo, issue_number: number,
    body: [
      '着手用Draft PR: #' + pull.number,
      '',
      'branch: ' + branch + ' / base: ' + settings.workBranch,
      'このPRを再利用して実装してください。'
    ].join('\n')
  });
  await reconcile({ github, context, core });
}

function fullName(owner, repo) {
  return owner + '/' + repo;
}

module.exports = {
  settingsFor,
  references,
  followUpReferences,
  related,
  statusFor,
  completionCandidate,
  failingRuns,
  changesRequested,
  projectAccess,
  reconcile,
  start
};
