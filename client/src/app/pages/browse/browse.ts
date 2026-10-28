import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../api.service';
import { Client, Project, Task } from '../../api.types';

const PAGE_SIZE = 10;

// Upstream returns no total count, so a full page is assumed to mean more data exists.
function hasMore(page: readonly unknown[]): boolean {
  return page.length === PAGE_SIZE;
}

interface ClientNode {
  client: Client;
  expanded: boolean;
  loadingProjects: boolean;
  /** null = never fetched, [] = fetched and empty. */
  projects: ProjectNode[] | null;
  moreProjects: boolean;
}

interface ProjectNode {
  project: Project;
  expanded: boolean;
  loadingTasks: boolean;
  /** null = never fetched, [] = fetched and empty. */
  tasks: Task[] | null;
  moreTasks: boolean;
}

@Component({
  selector: 'app-browse',
  templateUrl: './browse.html',
  styleUrl: './browse.css',
})
export class Browse {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly clientNodes = signal<ClientNode[]>([]);
  readonly clientsLoading = signal(false);
  readonly moreClients = signal(false);

  constructor() {
    this.loadClients();
  }

  loadClients(): void {
    this.clientsLoading.set(true);
    this.api.getClients({ limit: PAGE_SIZE, offset: this.clientNodes().length }).subscribe({
      next: (clients) => {
        this.clientNodes.update((nodes) => [...nodes, ...clients.map(toClientNode)]);
        this.moreClients.set(hasMore(clients));
        this.clientsLoading.set(false);
      },
      // The interceptor already showed the error banner; just stop loading.
      error: () => this.clientsLoading.set(false),
    });
  }

  toggleClient(node: ClientNode): void {
    if (!node.expanded && node.projects === null) {
      if (!node.loadingProjects) this.loadProjects(node);
      return;
    }
    node.expanded = !node.expanded;
    this.refresh();
  }

  loadProjects(node: ClientNode): void {
    node.loadingProjects = true;
    this.refresh();
    const params = { limit: PAGE_SIZE, offset: node.projects?.length ?? 0 };
    this.api.getProjects(node.client.id, params).subscribe({
      next: (projects) => {
        node.projects = [...(node.projects ?? []), ...projects.map(toProjectNode)];
        node.moreProjects = hasMore(projects);
        node.expanded = true;
        node.loadingProjects = false;
        this.refresh();
      },
      error: () => {
        node.loadingProjects = false;
        this.refresh();
      },
    });
  }

  toggleProject(node: ProjectNode): void {
    if (!node.expanded && node.tasks === null) {
      if (!node.loadingTasks) this.loadTasks(node);
      return;
    }
    node.expanded = !node.expanded;
    this.refresh();
  }

  loadTasks(node: ProjectNode): void {
    node.loadingTasks = true;
    this.refresh();
    const params = { limit: PAGE_SIZE, offset: node.tasks?.length ?? 0 };
    this.api.getTasks(node.project.id, params).subscribe({
      next: (tasks) => {
        node.tasks = [...(node.tasks ?? []), ...tasks];
        node.moreTasks = hasMore(tasks);
        node.expanded = true;
        node.loadingTasks = false;
        this.refresh();
      },
      error: () => {
        node.loadingTasks = false;
        this.refresh();
      },
    });
  }

  /** Jumps to the time-entries page, which opens a create form for this task. */
  logTime(task: Task): void {
    void this.router.navigate(['/time-entries'], { queryParams: { taskId: task.id } });
  }

  /** Nodes are mutated in place; cloning the top-level array notifies the signal. */
  private refresh(): void {
    this.clientNodes.update((nodes) => [...nodes]);
  }
}

function toClientNode(client: Client): ClientNode {
  return { client, expanded: false, loadingProjects: false, projects: null, moreProjects: false };
}

function toProjectNode(project: Project): ProjectNode {
  return { project, expanded: false, loadingTasks: false, tasks: null, moreTasks: false };
}
