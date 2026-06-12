import chalk from 'chalk';
import ora from 'ora';

export const logger = {
  info: (msg: string) => console.log(chalk.blue('info'), msg),
  success: (msg: string) => console.log(chalk.green('OK'), msg),
  error: (msg: string) => console.log(chalk.red('FAIL'), msg),
  warning: (msg: string) => console.log(chalk.yellow('warn'), msg),
  step: (msg: string) => console.log(chalk.cyan('-'), msg),
};

export function spinner(text: string) {
  return ora(text).start();
}
