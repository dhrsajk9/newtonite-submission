// Where the item is in its workflow. This IS a sequence, so it is drawn as one.
// Approval is only a required stop for payment and compliance items.
import type { ItemType, Status } from '../api';
import { STATUS_LABEL, STATUS_ORDER } from '../format';

const NEEDS_APPROVAL: ItemType[] = ['payment', 'compliance'];

export function WorkflowTrack({ status, type }: { status: Status; type: ItemType }) {
  const current = STATUS_ORDER.indexOf(status);
  const approvalRequired = NEEDS_APPROVAL.includes(type);
  return (
    <ol className="track" aria-label="Workflow">
      {STATUS_ORDER.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        const optional = s === 'AWAITING_APPROVAL' && !approvalRequired && status !== 'AWAITING_APPROVAL';
        return (
          <li key={s} className={`track-step ${state}${optional ? ' optional' : ''}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="track-dot" aria-hidden="true" />
            <span className="track-label">
              {STATUS_LABEL[s]}
              {optional && <span className="track-note">if needed</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
