import readline from 'node:readline';

/**
 * Prompt the user for input via stdin.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a yes/no confirmation.
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(`${question} ${hint} `);
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}
