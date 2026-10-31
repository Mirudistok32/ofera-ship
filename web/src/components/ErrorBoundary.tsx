import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type Props = { home: string; children: ReactNode };
type State = { failed: boolean };

/* Ловит ошибки рендера и lazy у детей. Обработчики и запросы — не его работа: там try/catch.
   Класс, потому что у getDerivedStateFromError и componentDidCatch нет хуков */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Упала страница:', error, info.componentStack);   // здесь же — отправка в мониторинг
  }

  render() {
    if (!this.state.failed) return this.props.children;
    /* Обычная ссылка, не Link: lazy запомнил неудачную загрузку, чанк заново запросит только полная перезагрузка */
    return (
      <div className="note" role="alert">
        <p><b>Что-то пошло не так… но мы как семья.</b> Остальной сайт работает.</p>
        <a className="btn btn-small" href={this.props.home}>К оглавлению</a>
      </div>
    );
  }
}
