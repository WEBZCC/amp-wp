const github = require('@actions/github');
const paginateByPath = require('./paginate_by_path');

const findIssuesWithinMilestoneQuery = `
	query (
	  $after: String
	  $searchQuery: String!
	) {
	  search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
		pageInfo {
		  endCursor
		  hasNextPage
		}
		nodes {
		  ... on Issue {
			title
			number
			author {
			  ... on User {
				name
				login
			  }
			}
			participants(first: 100) {
			  nodes {
				login
				name
			  }
			}
		  }
		  ... on PullRequest {
			number
			title
			bodyText
			author {
			  ... on User {
				name
				login
			  }
			}
			participants(first: 100) {
			  nodes {
				login
				name
			  }
			}
			commits(first: 200) {
			  nodes {
				commit {
				  authors(first: 10) {
					nodes {
					  user {
						login
						name
					  }
					}
				  }
				}
			  }
			}
		  }
		}
	  }
	}
`;

export default class ReleaseBody {
	constructor(milestone) {
		this.milestone = milestone;

		this.changelogEntries = new Map();
		this.contributorEntries = new Map();

		this.authorsToIgnore = ['CLAassistant', 'dependabot', 'dependabot-preview[bot]', 'googlebot', 'renovate-bot'];

		this.graphQlVariables = {
			// searchQuery: `repo:${process.env.GITHUB_REPOSITORY} milestone:${milestone} is:closed`
			searchQuery: `repo:ampproject/amp-wp milestone:${milestone} is:closed`
		};
	}

	async generate() {
		const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
		const { search } = await paginateByPath(octokit.graphql, findIssuesWithinMilestoneQuery, this.graphQlVariables, [
			'search'
		]);

		search.nodes.forEach(issueOrPr => {
			// Skip if author is in ignore list, or an empty author object was returned (usually happens when the author is a bot).
			if (this.authorsToIgnore.includes(issueOrPr.author.login) || Object.entries(issueOrPr.author).length === 0) {
				return;
			}

			// Add issue/PR author as a contributor.
			if (!this.contributorEntries.has(issueOrPr.author.login)) {
				this.contributorEntries.set(issueOrPr.author.login, issueOrPr.author.name);
			}

			// Add participants of issue/PR to list of contributors.
			issueOrPr.participants.nodes.forEach(participant => {
				if (!this.contributorEntries.has(participant.login)) {
					this.contributorEntries.set(participant.login, participant.name);
				}
			});

			const currentClosedItems =
				'closedItems' in (this.changelogEntries.get(issueOrPr.number) || {})
					? this.changelogEntries.get(issueOrPr.number).closedItems
					: [];
			const currentChangelogEntry = {
				title: issueOrPr.title,
				closedItems: [issueOrPr.number, ...currentClosedItems]
			};

			// It's a PR if it has commits.
			if ('commits' in issueOrPr) {
				this.handlePr(issueOrPr, currentChangelogEntry);
			} else {
				// It's an issue.
				this.handleIssue(issueOrPr, currentChangelogEntry);
			}
		});

		return `## Changelog\n${this.generateChangelog()}\n\n## Contributors\n${this.generateContributors()}`;
	}

	handlePr(pr, currentChangelogEntry) {
		const commits = pr.commits.nodes;

		// Retrieve list of commit authors and add them as contributors.
		commits.forEach(commit => {
			const authors = commit.commit.authors.nodes;

			authors.forEach(author => {
				if (!this.contributorEntries.has(author.user.login)) {
					this.contributorEntries.set(author.user.login, author.user.name);
				}
			});
		});

		const closedItems = [...pr.bodyText.matchAll(/(?:Fixes|Fixed|Fix|Closes|Closed|Close)\s+#(\d+)/gi)];

		// Add changelog entry for PR if it doesn't close any issues/PRs.
		if (closedItems.length === 0) {
			this.changelogEntries.set(pr.number, currentChangelogEntry);
			return;
		}

		closedItems.forEach(([, closedItemNumber]) => {
			const itemNumber = parseInt(closedItemNumber, 10);
			if (!this.changelogEntries.has(itemNumber)) {
				this.changelogEntries.set(itemNumber, { closedItems: [pr.number] });
			} else {
				const closedItemNumberEntry = this.changelogEntries.get(itemNumber);
				if (closedItemNumberEntry.closedItems.includes(pr.number)) {
					return;
				}
				closedItemNumberEntry.closedItems.push(pr.number);
			}
		});
	}

	handleIssue(issue, currentChangelogEntry) {
		this.changelogEntries.set(issue.number, currentChangelogEntry);
	}

	generateChangelog() {
		return [...this.changelogEntries.entries()]
			.map(([itemNumber, details]) => {
				if (!details.title) {
					throw new Error(`Title for #${itemNumber} was not set. Is it apart of the milestone?`);
				}

				return `- ${details.title}. (${details.closedItems.map(closedItem => `#${closedItem}`).join(', ')})`;
			})
			.join('\n');
	}

	generateContributors() {
		return [...this.contributorEntries.entries()]
			.filter(([username]) => !this.authorsToIgnore.includes(username))
			.sort(([aUsername, aName], [bUsername, bName]) => {
				const aComparator = aName || aUsername;
				const bComparator = bName || bUsername;

				if (aComparator.toLowerCase() < bComparator.toLowerCase()) {
					return -1;
				}
				if (aComparator.toLowerCase() > bComparator.toLowerCase()) {
					return 1;
				}
				return 0;
			})
			.map(([username, name]) => (name === null ? `@${username}` : `${name} (@${username})`))
			.join(', ');
	}
}
