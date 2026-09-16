export function trimToastStack(stack, maximum) {
  while (stack.children.length > maximum) {
    const oldest = stack.firstElementChild;
    if (!oldest) break;
    clearTimeout(Number(oldest.dataset.timer));
    oldest.remove();
  }
}
