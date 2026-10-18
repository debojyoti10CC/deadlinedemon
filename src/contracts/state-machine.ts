import type { ContractState } from '../types.js';
const transitions: Record<ContractState, readonly ContractState[]> = {
 pending: ['active','cancelled'], active: ['completed','missed','cancelled'],
 missed: ['completed','cancelled'], completed: [], cancelled: [],
};
export function assertTransition(from: ContractState, to: ContractState): void {
 if (!transitions[from].includes(to)) throw new Error(`Invalid contract transition: ${from} -> ${to}`);
}
