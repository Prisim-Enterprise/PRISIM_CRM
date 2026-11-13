import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface DirectoryUser { id: string; fullName: string; teamId: string | null; teamIds: string[]; roles: { role: { key: string } }[] }

/** Whether someone shares at least one team with the signed-in person (teams they lead count). */
export const sharesTeam = (u: { teamIds?: string[]; teamId?: string | null }, myTeamIds: string[] = []) =>
  (u.teamIds ?? (u.teamId ? [u.teamId] : [])).some((t) => myTeamIds.includes(t));
export interface Team { id: string; name: string; leaderId: string | null; leader: { id: string; fullName: string } | null; _count: { members: number } }

export const useDirectory = () =>
  useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirectoryUser[]>('/users/directory'), staleTime: 60_000 });

export const useTeams = () =>
  useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/teams'), staleTime: 60_000 });
