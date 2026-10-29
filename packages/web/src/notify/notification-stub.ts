import { vi, type Mock } from 'vitest';

type RequestPermission = (
  callback?: NotificationPermissionCallback,
) => Promise<NotificationPermission> | undefined;

const resolvesCurrent = (): Mock<RequestPermission> =>
  vi.fn<RequestPermission>(() => Promise.resolve(FakeNotification.permission));

/** Tests: a fake `Notification` that records what was shown. */
export class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  static requestPermission: Mock<RequestPermission> = resolvesCurrent();
  onclick: (() => void) | null = null;
  close: Mock<() => void> = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions = {},
  ) {
    FakeNotification.instances.push(this);
  }
}

export function stubNotification(permission: NotificationPermission = 'granted') {
  FakeNotification.permission = permission;
  FakeNotification.instances = [];
  FakeNotification.requestPermission = resolvesCurrent();
  vi.stubGlobal('Notification', FakeNotification);
  return FakeNotification;
}
