import * as vscode from 'vscode';
import { RemoteTransport } from '../transport/remoteTransport';
import { ResolvedWatchRule, resolveWatchRules, generateWatchRule } from './processMatchResolver';
import { WatchedProcess } from '../types';

export async function pickWatchRule(
  transport: RemoteTransport,
  businessName: string
): Promise<ResolvedWatchRule | undefined> {
  const { recommended, alternatives } = await resolveWatchRules(transport, businessName);

  const needsPick =
    alternatives.length > 0 &&
    (!recommended.autoSelected || recommended.candidates.length > 3);

  if (!needsPick) {
    const confirm = await vscode.window.showInformationMessage(
      `Watch rule: \`${recommended.match}\` — ${recommended.reason}`,
      'Use this rule',
      'Choose another'
    );
    if (confirm === 'Use this rule' || confirm === undefined) {
      return recommended;
    }
    if (confirm !== 'Choose another') {
      return undefined;
    }
  }

  const pick = await vscode.window.showQuickPick(
    [
      {
        label: `Recommended: ${recommended.match}`,
        description: recommended.reason,
        rule: recommended,
      },
      ...alternatives.map((a) => ({
        label: a.match,
        description: a.reason,
        rule: a,
      })),
    ],
    { placeHolder: `Match rule for "${businessName}"` }
  );

  return pick?.rule;
}

export function watchRuleToEntry(rule: ResolvedWatchRule): WatchedProcess {
  return {
    match: rule.match,
    label: rule.label,
    alias: rule.alias,
  };
}

export async function resolveAndPickWatchRule(
  transport: RemoteTransport | undefined,
  businessName: string
): Promise<ResolvedWatchRule> {
  if (transport) {
    const picked = await pickWatchRule(transport, businessName);
    if (picked) {
      return picked;
    }
  }
  return generateWatchRule(businessName, []);
}
