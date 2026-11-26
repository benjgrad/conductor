// The words of the landing page (`/welcome`) and the onboarding tour: what conductor is for and
// what it does, written once so the two never disagree. Every claim names a feature that exists.

export const TAGLINE = 'Your Claude Code agents, working your tickets, on your machines.';

export const PITCH =
  'Conductor runs Claude Code sessions for you across your own laptops and servers. Each ticket ' +
  'moves through a workflow you control, from plan to pull request, and the board only asks for ' +
  'you when a decision is yours.';

export interface Feature {
  /** Short, scannable: the card's heading. */
  title: string;
  body: string;
}

/** The main features, in the order a new user meets them. */
export const FEATURES: readonly Feature[] = [
  {
    title: 'A board for agents',
    body:
      'Write a ticket and it queues. An agent picks it up, plans, implements and opens the PR. ' +
      'Every card shows its column, its machine and what it is waiting on.',
  },
  {
    title: 'Workflows you own',
    body:
      'Each account has its own workflow, seeded with a sensible default: planning, ' +
      'implementing, review. Change the prompts, states, checks and approvals to fit how you work.',
  },
  {
    title: 'Your machines, your code',
    body:
      'Agents run on machines you enroll with one install command, in a fresh worktree per ' +
      'ticket. Your code and credentials stay on your hardware.',
  },
  {
    title: 'You decide, it does the rest',
    body:
      'When an agent needs a decision it asks one clear question, with its recommended answer. ' +
      'Answer from the board or a push notification, and it carries on.',
  },
  {
    title: 'Checks before review',
    body:
      'Build, lint and test gates run in a fresh checkout before a PR reaches you, so what you ' +
      'review is green. A human merges; agents never mark their own work done.',
  },
  {
    title: 'Works from Claude',
    body:
      'Connect Claude to conductor over MCP and create tickets, answer questions, read plans and ' +
      'follow progress from a conversation.',
  },
];

/** "How it works", three steps. */
export const STEPS: readonly Feature[] = [
  {
    title: 'Enroll a machine',
    body: 'Run one command on a laptop or server with Claude Code. It connects and reports its repos.',
  },
  {
    title: 'Write a ticket',
    body: 'Say what you want in a repo. Conductor queues it and an agent on your machine starts.',
  },
  {
    title: 'Review the pull request',
    body: 'Answer the questions it asks along the way, then review a PR whose checks already pass.',
  },
];
