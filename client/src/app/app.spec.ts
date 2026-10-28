import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { ErrorService } from './error.service';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should render the nav links', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('nav a'),
    ).map((a) => a.textContent?.trim());
    expect(links).toEqual(['Browse', 'Time Entries']);
  });

  it('should show and dismiss the error banner', async () => {
    const fixture = TestBed.createComponent(App);
    const element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    expect(element.querySelector('.error-banner')).toBeNull();

    TestBed.inject(ErrorService).show('Something broke');
    await fixture.whenStable();
    expect(element.querySelector('.error-banner')?.textContent).toContain('Something broke');

    element.querySelector<HTMLButtonElement>('.error-banner button')?.click();
    await fixture.whenStable();
    expect(element.querySelector('.error-banner')).toBeNull();
  });
});
