#!/usr/bin/env node

// Native
const path = require('path')

// Packages
const GitHubAPI = require('github')
const args = require('args')
const {green} = require('chalk')
const semVer = require('semver')
const inquirer = require('inquirer')
const ora = require('ora')

// Ours
const pkg = require('./package')
const groupChanges = require('./lib/group')
const getRepo = require('./lib/repo')
const abort = require('./lib/abort')
const getCommits = require('./lib/commits')
const getChoices = require('./lib/choices')
const typeDefined = require('./lib/type')
const findToken = require('./lib/token')
const createChangelog = require('./lib/changelog')

args
  .option('draft', `Don't publish the release right away`)
  .option('pre', 'Mark the release as prerelease')
  .option('overwrite', 'If the release already exists, replace it')

const flags = args.parse(process.argv)

let spinner
let githubConnection
let repoDetails

const newSpinner = message => {
  if (spinner) {
    spinner.succeed()
  }

  spinner = ora(message).start()
}

const failSpinner = message => {
  if (spinner) {
    spinner.fail()
  }

  console.log('')
  abort(message)
}

const changeTypes = [
  {
    handle: 'major',
    name: 'Major Change',
    description: 'incompatible API change'
  },
  {
    handle: 'minor',
    name: 'Minor Change',
    description: 'backwards-compatible functionality'
  },
  {
    handle: 'patch',
    name: 'Patch',
    description: 'backwards-compatible bug fix'
  }
]

const connector = () => {
  newSpinner('Searching for GitHub token on device')
  const token = findToken()

  const github = new GitHubAPI({
    protocol: 'https',
    headers: {
      'user-agent': `Release v${pkg.version}`
    }
  })

  github.authenticate({
    type: 'token',
    token
  })

  return github
}

const getReleaseURL = version => {
  if (!repoDetails) {
    return ''
  }

  let releaseURL = `https://github.com/${repoDetails.user}`
  releaseURL += `/${repoDetails.repo}/releases`
  releaseURL += `/tag/${version}`

  return releaseURL
}

const createRelease = (tag_name, changelog, exists) => {
  const isPre = flags.pre ? 'pre' : ''
  newSpinner(`Uploading ${isPre}release` + (flags.draft ? ' as draft' : ''))

  const methodPrefix = exists ? 'edit' : 'create'
  const method = methodPrefix + 'Release'

  const body = {
    owner: repoDetails.user,
    repo: repoDetails.repo,
    tag_name,
    body: changelog,
    draft: flags.draft,
    prerelease: flags.pre
  }

  if (exists) {
    body.id = exists
  }

  githubConnection.repos[method](body, err => {
    if (err) {
      console.log('\n')
      abort('Failed to upload release.')
    }

    spinner.succeed()

    console.log(`\nDone! 🎉`)
    console.log(`Here's the release: ${getReleaseURL(tag_name)}`)
  })
}

const orderCommits = (commits, latest, exists) => {
  const questions = []
  const predefined = {}

  // Show the latest changes first
  commits.reverse()

  for (const commit of commits) {
    const defTitle = typeDefined(commit.title, changeTypes)
    const defDescription = typeDefined(commit.description, changeTypes)

    const definition = defTitle || defDescription

    if (definition) {
      predefined[commit.hash] = definition
      continue
    }

    questions.push({
      name: commit.hash,
      message: commit.title,
      type: 'list',
      choices: getChoices(changeTypes)
    })
  }

  spinner.succeed()

  // Prevents the spinner from getting succeeded
  // again once new spinner gets created
  spinner = false

  console.log(`${green('!')} Please enter the type of change for each commit:\n`)

  inquirer.prompt(questions).then(types => {
    // Update the spinner status
    console.log('')
    newSpinner('Generating the changelog')

    const results = Object.assign({}, predefined, types)
    const grouped = groupChanges(results, changeTypes)
    const changelog = createChangelog(grouped, commits, changeTypes)

    // Upload changelog to GitHub Releases
    createRelease(latest.title, changelog, exists)
  })
}

const collectChanges = exists => {
  newSpinner('Loading commit history')

  getCommits().then(commits => {
    const latestCommit = commits.shift()

    if (!latestCommit) {
      failSpinner('Could not load latest commits.')
    }

    const isTag = semVer.valid(latestCommit.title)

    if (!isTag) {
      failSpinner('The latest commit wasn\'t created by `npm version`.')
    }

    for (const commit of commits) {
      if (semVer.valid(commit.title)) {
        const index = commits.indexOf(commit)
        commits = commits.slice(0, index)
        break
      }
    }

    if (commits.length < 1) {
      failSpinner('No changes happened since the last release.')
    }

    orderCommits(commits, latestCommit, exists)
  })
}

const checkReleaseStatus = project => {
  githubConnection = connector()
  repoDetails = getRepo(project.repository)

  newSpinner('Checking if release already exists')

  githubConnection.repos.getReleaseByTag({
    owner: repoDetails.user,
    repo: repoDetails.repo,
    tag: project.version
  }, (err, response) => {
    if (err) {
      collectChanges(false)
      return
    }

    if (flags.overwrite) {
      spinner.text = 'Overwriting release, because it already exists'
    }

    if (flags.overwrite) {
      collectChanges(response.id)
      return
    }

    spinner.succeed()
    console.log('')

    const releaseURL = getReleaseURL(project.version)
    abort(`Release already exists: ${releaseURL}`)
  })
}

const infoPath = path.join(process.cwd(), 'package.json')
let info

try {
  info = require(infoPath)
} catch (err) {
  abort('Could not find a package.json file.')
}

if (!info.repository) {
  abort('No repository field inside the package.json file.')
}

if (!info.version) {
  abort('No version field inside the package.json file.')
}

checkReleaseStatus(info)
