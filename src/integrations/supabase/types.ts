export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      announcements: {
        Row: {
          audience: string
          body: string
          created_at: string
          created_by: string | null
          id: string
          published: boolean
          published_at: string
          title: string
          updated_at: string
        }
        Insert: {
          audience?: string
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          published?: boolean
          published_at?: string
          title: string
          updated_at?: string
        }
        Update: {
          audience?: string
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          published?: boolean
          published_at?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_days: {
        Row: {
          check_in_at: string | null
          check_in_device: Json
          check_out_at: string | null
          check_out_device: Json
          created_at: string
          exception_note: string | null
          exception_type: Database["public"]["Enums"]["day_exception"]
          id: string
          import_batch_id: string | null
          late_reason: string | null
          location_accuracy_m: number | null
          location_distance_m: number | null
          location_latitude: number | null
          location_longitude: number | null
          location_status: string
          office_location_id: string | null
          required_minutes: number
          source: string
          updated_at: string
          user_id: string
          work_date: string
          work_mode: Database["public"]["Enums"]["attendance_work_mode"]
        }
        Insert: {
          check_in_at?: string | null
          check_in_device?: Json
          check_out_at?: string | null
          check_out_device?: Json
          created_at?: string
          exception_note?: string | null
          exception_type?: Database["public"]["Enums"]["day_exception"]
          id?: string
          import_batch_id?: string | null
          late_reason?: string | null
          location_accuracy_m?: number | null
          location_distance_m?: number | null
          location_latitude?: number | null
          location_longitude?: number | null
          location_status?: string
          office_location_id?: string | null
          required_minutes?: number
          source?: string
          updated_at?: string
          user_id: string
          work_date?: string
          work_mode?: Database["public"]["Enums"]["attendance_work_mode"]
        }
        Update: {
          check_in_at?: string | null
          check_in_device?: Json
          check_out_at?: string | null
          check_out_device?: Json
          created_at?: string
          exception_note?: string | null
          exception_type?: Database["public"]["Enums"]["day_exception"]
          id?: string
          import_batch_id?: string | null
          late_reason?: string | null
          location_accuracy_m?: number | null
          location_distance_m?: number | null
          location_latitude?: number | null
          location_longitude?: number | null
          location_status?: string
          office_location_id?: string | null
          required_minutes?: number
          source?: string
          updated_at?: string
          user_id?: string
          work_date?: string
          work_mode?: Database["public"]["Enums"]["attendance_work_mode"]
        }
        Relationships: [
          {
            foreignKeyName: "attendance_days_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_days_office_location_id_fkey"
            columns: ["office_location_id"]
            isOneToOne: false
            referencedRelation: "office_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_days_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string
          detail: Json
          entity_id: string | null
          entity_type: string
          id: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          entity_id?: string | null
          entity_type: string
          id?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          entity_id?: string | null
          entity_type?: string
          id?: string
        }
        Relationships: []
      }
      automation_flags: {
        Row: {
          created_at: string
          day_id: string | null
          detail: Json
          id: string
          message: string
          resolved_at: string | null
          rule: string
          run_id: string | null
          severity: string
          user_id: string
          work_date: string
        }
        Insert: {
          created_at?: string
          day_id?: string | null
          detail?: Json
          id?: string
          message: string
          resolved_at?: string | null
          rule: string
          run_id?: string | null
          severity?: string
          user_id: string
          work_date: string
        }
        Update: {
          created_at?: string
          day_id?: string | null
          detail?: Json
          id?: string
          message?: string
          resolved_at?: string | null
          rule?: string
          run_id?: string | null
          severity?: string
          user_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_flags_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "attendance_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_flags_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "automation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_flags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_runs: {
        Row: {
          days_scanned: number
          detail: Json
          finished_at: string | null
          flags_created: number
          id: string
          notifications_sent: number
          reason: string | null
          skipped: boolean
          started_at: string
          trigger_source: string
        }
        Insert: {
          days_scanned?: number
          detail?: Json
          finished_at?: string | null
          flags_created?: number
          id?: string
          notifications_sent?: number
          reason?: string | null
          skipped?: boolean
          started_at?: string
          trigger_source?: string
        }
        Update: {
          days_scanned?: number
          detail?: Json
          finished_at?: string | null
          flags_created?: number
          id?: string
          notifications_sent?: number
          reason?: string | null
          skipped?: boolean
          started_at?: string
          trigger_source?: string
        }
        Relationships: []
      }
      automation_settings: {
        Row: {
          enabled: boolean
          eod_lock_hours: number
          high_rejection_pct: number
          id: string
          lookback_days: number
          low_productivity_pct: number
          missed_checkout_grace_hours: number
          no_checkin_cutoff: string
          reminder_interval_minutes: number
          uncovered_ratio_pct: number
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          eod_lock_hours?: number
          high_rejection_pct?: number
          id?: string
          lookback_days?: number
          low_productivity_pct?: number
          missed_checkout_grace_hours?: number
          no_checkin_cutoff?: string
          reminder_interval_minutes?: number
          uncovered_ratio_pct?: number
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          eod_lock_hours?: number
          high_rejection_pct?: number
          id?: string
          lookback_days?: number
          low_productivity_pct?: number
          missed_checkout_grace_hours?: number
          no_checkin_cutoff?: string
          reminder_interval_minutes?: number
          uncovered_ratio_pct?: number
          updated_at?: string
        }
        Relationships: []
      }
      blockers: {
        Row: {
          allocation_id: string | null
          category: Database["public"]["Enums"]["blocker_category"]
          created_at: string
          day_id: string
          description: string
          id: string
          notified_at: string | null
          notified_lead_id: string | null
          project_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          severity: Database["public"]["Enums"]["blocker_severity"]
          started_at: string
          status: Database["public"]["Enums"]["blocker_status"]
          user_id: string
        }
        Insert: {
          allocation_id?: string | null
          category?: Database["public"]["Enums"]["blocker_category"]
          created_at?: string
          day_id: string
          description: string
          id?: string
          notified_at?: string | null
          notified_lead_id?: string | null
          project_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["blocker_severity"]
          started_at?: string
          status?: Database["public"]["Enums"]["blocker_status"]
          user_id: string
        }
        Update: {
          allocation_id?: string | null
          category?: Database["public"]["Enums"]["blocker_category"]
          created_at?: string
          day_id?: string
          description?: string
          id?: string
          notified_at?: string | null
          notified_lead_id?: string | null
          project_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["blocker_severity"]
          started_at?: string
          status?: Database["public"]["Enums"]["blocker_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blockers_allocation_id_fkey"
            columns: ["allocation_id"]
            isOneToOne: false
            referencedRelation: "project_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blockers_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "attendance_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blockers_notified_lead_id_fkey"
            columns: ["notified_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blockers_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blockers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      break_logs: {
        Row: {
          category: Database["public"]["Enums"]["break_category"]
          created_at: string
          day_id: string
          ended_at: string | null
          id: string
          note: string | null
          started_at: string
          user_id: string
        }
        Insert: {
          category?: Database["public"]["Enums"]["break_category"]
          created_at?: string
          day_id: string
          ended_at?: string | null
          id?: string
          note?: string | null
          started_at: string
          user_id: string
        }
        Update: {
          category?: Database["public"]["Enums"]["break_category"]
          created_at?: string
          day_id?: string
          ended_at?: string | null
          id?: string
          note?: string | null
          started_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "break_logs_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "attendance_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "break_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      documents: {
        Row: {
          created_at: string
          doc_type: Database["public"]["Enums"]["document_type"]
          file_name: string
          file_path: string
          id: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["document_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          doc_type: Database["public"]["Enums"]["document_type"]
          file_name: string
          file_path: string
          id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["document_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          doc_type?: Database["public"]["Enums"]["document_type"]
          file_name?: string
          file_path?: string
          id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["document_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      eod_reports: {
        Row: {
          challenges: string | null
          created_at: string
          day_id: string
          highlights: string | null
          id: string
          metrics: Json
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["eod_status"]
          submitted_at: string | null
          support_needed: string | null
          tomorrow_plan: string | null
          updated_at: string
          user_id: string
          work_date: string
        }
        Insert: {
          challenges?: string | null
          created_at?: string
          day_id: string
          highlights?: string | null
          id?: string
          metrics?: Json
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["eod_status"]
          submitted_at?: string | null
          support_needed?: string | null
          tomorrow_plan?: string | null
          updated_at?: string
          user_id: string
          work_date: string
        }
        Update: {
          challenges?: string | null
          created_at?: string
          day_id?: string
          highlights?: string | null
          id?: string
          metrics?: Json
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["eod_status"]
          submitted_at?: string | null
          support_needed?: string | null
          tomorrow_plan?: string | null
          updated_at?: string
          user_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "eod_reports_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: true
            referencedRelation: "attendance_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eod_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eod_reports_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          committed_at: string | null
          created_at: string
          created_by: string | null
          date_from: string | null
          date_to: string | null
          file_name: string
          id: string
          sheet_names: string[]
          status: string
          summary: Json
          updated_at: string
        }
        Insert: {
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          date_from?: string | null
          date_to?: string | null
          file_name: string
          id?: string
          sheet_names?: string[]
          status?: string
          summary?: Json
          updated_at?: string
        }
        Update: {
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          date_from?: string | null
          date_to?: string | null
          file_name?: string
          id?: string
          sheet_names?: string[]
          status?: string
          summary?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_cells: {
        Row: {
          batch_id: string
          calendar_kind: string | null
          created_at: string
          exception_type: Database["public"]["Enums"]["day_exception"] | null
          half_day: boolean
          id: string
          mapped_kind: string
          note: string | null
          raw_value: string | null
          row_id: string
          signal_type: string | null
          state: string
          work_date: string
          work_mode: Database["public"]["Enums"]["attendance_work_mode"] | null
        }
        Insert: {
          batch_id: string
          calendar_kind?: string | null
          created_at?: string
          exception_type?: Database["public"]["Enums"]["day_exception"] | null
          half_day?: boolean
          id?: string
          mapped_kind: string
          note?: string | null
          raw_value?: string | null
          row_id: string
          signal_type?: string | null
          state?: string
          work_date: string
          work_mode?: Database["public"]["Enums"]["attendance_work_mode"] | null
        }
        Update: {
          batch_id?: string
          calendar_kind?: string | null
          created_at?: string
          exception_type?: Database["public"]["Enums"]["day_exception"] | null
          half_day?: boolean
          id?: string
          mapped_kind?: string
          note?: string | null
          raw_value?: string | null
          row_id?: string
          signal_type?: string | null
          state?: string
          work_date?: string
          work_mode?: Database["public"]["Enums"]["attendance_work_mode"] | null
        }
        Relationships: [
          {
            foreignKeyName: "import_cells_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_cells_row_id_fkey"
            columns: ["row_id"]
            isOneToOne: false
            referencedRelation: "import_rows"
            referencedColumns: ["id"]
          },
        ]
      }
      import_rows: {
        Row: {
          batch_id: string
          created_at: string
          date_issues: Json
          id: string
          invitation_id: string | null
          match_reason: string | null
          match_state: string
          matched_user_id: string | null
          metadata: Json
          parsed_doj: string | null
          parsed_lwd: string | null
          project_id: string | null
          raw_doj: string | null
          raw_identifier: string | null
          raw_lwd: string | null
          raw_name: string | null
          resolution: string
          row_index: number
          sheet_name: string
          updated_at: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          date_issues?: Json
          id?: string
          invitation_id?: string | null
          match_reason?: string | null
          match_state?: string
          matched_user_id?: string | null
          metadata?: Json
          parsed_doj?: string | null
          parsed_lwd?: string | null
          project_id?: string | null
          raw_doj?: string | null
          raw_identifier?: string | null
          raw_lwd?: string | null
          raw_name?: string | null
          resolution?: string
          row_index: number
          sheet_name: string
          updated_at?: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          date_issues?: Json
          id?: string
          invitation_id?: string | null
          match_reason?: string | null
          match_state?: string
          matched_user_id?: string | null
          metadata?: Json
          parsed_doj?: string | null
          parsed_lwd?: string | null
          project_id?: string | null
          raw_doj?: string | null
          raw_identifier?: string | null
          raw_lwd?: string | null
          raw_name?: string | null
          resolution?: string
          row_index?: number
          sheet_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_matched_user_id_fkey"
            columns: ["matched_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      import_signals: {
        Row: {
          batch_id: string
          created_at: string
          effective_date: string
          handled_at: string | null
          handled_by: string | null
          id: string
          raw_value: string | null
          row_id: string
          signal_type: string
          status: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          effective_date: string
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          raw_value?: string | null
          row_id: string
          signal_type: string
          status?: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          effective_date?: string
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          raw_value?: string | null
          row_id?: string
          signal_type?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_signals_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_signals_handled_by_fkey"
            columns: ["handled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_signals_row_id_fkey"
            columns: ["row_id"]
            isOneToOne: false
            referencedRelation: "import_rows"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          attempts: number
          batch_id: string | null
          category: Database["public"]["Enums"]["user_category"]
          created_at: string
          created_by: string | null
          department_id: string | null
          designation: string | null
          email: string
          expires_at: string
          full_name: string
          id: string
          invited_user_id: string | null
          last_error: string | null
          metadata: Json
          next_attempt_at: string
          purpose: string
          queued_at: string
          reporting_lead_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          sent_at: string | null
          source: string
          status: Database["public"]["Enums"]["invitation_status"]
          token_hash: string | null
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          attempts?: number
          batch_id?: string | null
          category?: Database["public"]["Enums"]["user_category"]
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          designation?: string | null
          email: string
          expires_at?: string
          full_name: string
          id?: string
          invited_user_id?: string | null
          last_error?: string | null
          metadata?: Json
          next_attempt_at?: string
          purpose?: string
          queued_at?: string
          reporting_lead_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          sent_at?: string | null
          source?: string
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash?: string | null
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          attempts?: number
          batch_id?: string | null
          category?: Database["public"]["Enums"]["user_category"]
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          designation?: string | null
          email?: string
          expires_at?: string
          full_name?: string
          id?: string
          invited_user_id?: string | null
          last_error?: string | null
          metadata?: Json
          next_attempt_at?: string
          purpose?: string
          queued_at?: string
          reporting_lead_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          sent_at?: string | null
          source?: string
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_invited_user_id_fkey"
            columns: ["invited_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_reporting_lead_id_fkey"
            columns: ["reporting_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_leases: {
        Row: {
          job_name: string
          locked_at: string
          locked_until: string
          pause_reason: string | null
          paused: boolean
        }
        Insert: {
          job_name: string
          locked_at?: string
          locked_until: string
          pause_reason?: string | null
          paused?: boolean
        }
        Update: {
          job_name?: string
          locked_at?: string
          locked_until?: string
          pause_reason?: string | null
          paused?: boolean
        }
        Relationships: []
      }
      notifications: {
        Row: {
          actor_id: string | null
          body: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          read_at: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          read_at?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          read_at?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      office_locations: {
        Row: {
          address: string | null
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          latitude: number
          longitude: number
          name: string
          radius_meters: number
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          latitude: number
          longitude: number
          name: string
          radius_meters?: number
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          latitude?: number
          longitude?: number
          name?: string
          radius_meters?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "office_locations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      org_calendar_days: {
        Row: {
          calendar_date: string
          created_at: string
          id: string
          kind: string
          label: string | null
          project_id: string | null
          source: string
        }
        Insert: {
          calendar_date: string
          created_at?: string
          id?: string
          kind: string
          label?: string | null
          project_id?: string | null
          source?: string
        }
        Update: {
          calendar_date?: string
          created_at?: string
          id?: string
          kind?: string
          label?: string | null
          project_id?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_calendar_days_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          action: string
          description: string
          key: string
          resource: string
          scope: string
        }
        Insert: {
          action: string
          description: string
          key: string
          resource: string
          scope: string
        }
        Update: {
          action?: string
          description?: string
          key?: string
          resource?: string
          scope?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_status: Database["public"]["Enums"]["account_status"]
          available_hours_per_day: number | null
          category: Database["public"]["Enums"]["user_category"]
          created_at: string
          current_address: string | null
          date_of_birth: string | null
          department_id: string | null
          designation: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          employee_code: string | null
          employment_status: Database["public"]["Enums"]["employment_status"]
          experience_years: number | null
          full_name: string
          id: string
          institution: string | null
          internship_end: string | null
          internship_start: string | null
          joining_date: string | null
          last_working_day: string | null
          mobile: string | null
          needs_assignment: boolean
          permanent_address: string | null
          personal_email: string | null
          photo_url: string | null
          profile_submitted_at: string | null
          profile_verified_at: string | null
          profile_verified_by: string | null
          reporting_lead_id: string | null
          skills: string[] | null
          updated_at: string
          work_email: string
          work_location: string | null
        }
        Insert: {
          account_status?: Database["public"]["Enums"]["account_status"]
          available_hours_per_day?: number | null
          category: Database["public"]["Enums"]["user_category"]
          created_at?: string
          current_address?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          designation?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          employee_code?: string | null
          employment_status?: Database["public"]["Enums"]["employment_status"]
          experience_years?: number | null
          full_name: string
          id: string
          institution?: string | null
          internship_end?: string | null
          internship_start?: string | null
          joining_date?: string | null
          last_working_day?: string | null
          mobile?: string | null
          needs_assignment?: boolean
          permanent_address?: string | null
          personal_email?: string | null
          photo_url?: string | null
          profile_submitted_at?: string | null
          profile_verified_at?: string | null
          profile_verified_by?: string | null
          reporting_lead_id?: string | null
          skills?: string[] | null
          updated_at?: string
          work_email: string
          work_location?: string | null
        }
        Update: {
          account_status?: Database["public"]["Enums"]["account_status"]
          available_hours_per_day?: number | null
          category?: Database["public"]["Enums"]["user_category"]
          created_at?: string
          current_address?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          designation?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          employee_code?: string | null
          employment_status?: Database["public"]["Enums"]["employment_status"]
          experience_years?: number | null
          full_name?: string
          id?: string
          institution?: string | null
          internship_end?: string | null
          internship_start?: string | null
          joining_date?: string | null
          last_working_day?: string | null
          mobile?: string | null
          needs_assignment?: boolean
          permanent_address?: string | null
          personal_email?: string | null
          photo_url?: string | null
          profile_submitted_at?: string | null
          profile_verified_at?: string | null
          profile_verified_by?: string | null
          reporting_lead_id?: string | null
          skills?: string[] | null
          updated_at?: string
          work_email?: string
          work_location?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_profile_verified_by_fkey"
            columns: ["profile_verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_reporting_lead_id_fkey"
            columns: ["reporting_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_allocations: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          acknowledgment_note: string | null
          allocated_by: string | null
          allocation_pct: number
          created_at: string
          daily_task_target: number | null
          end_date: string | null
          hours_per_day: number
          id: string
          max_rejection_rate_pct: number | null
          over_allocation_override: boolean
          project_id: string
          quality_target_pct: number | null
          reporting_lead_id: string | null
          role_in_project: string | null
          start_date: string
          status: Database["public"]["Enums"]["allocation_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          acknowledgment_note?: string | null
          allocated_by?: string | null
          allocation_pct?: number
          created_at?: string
          daily_task_target?: number | null
          end_date?: string | null
          hours_per_day?: number
          id?: string
          max_rejection_rate_pct?: number | null
          over_allocation_override?: boolean
          project_id: string
          quality_target_pct?: number | null
          reporting_lead_id?: string | null
          role_in_project?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["allocation_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          acknowledgment_note?: string | null
          allocated_by?: string | null
          allocation_pct?: number
          created_at?: string
          daily_task_target?: number | null
          end_date?: string | null
          hours_per_day?: number
          id?: string
          max_rejection_rate_pct?: number | null
          over_allocation_override?: boolean
          project_id?: string
          quality_target_pct?: number | null
          reporting_lead_id?: string | null
          role_in_project?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["allocation_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_allocations_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_allocations_allocated_by_fkey"
            columns: ["allocated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_allocations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_allocations_reporting_lead_id_fkey"
            columns: ["reporting_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_allocations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_team_leads: {
        Row: {
          created_at: string
          id: string
          lead_id: string
          project_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          lead_id: string
          project_id: string
        }
        Update: {
          created_at?: string
          id?: string
          lead_id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_team_leads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_team_leads_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          client_name: string | null
          code: string
          created_at: string
          created_by: string | null
          daily_task_target: number | null
          description: string | null
          end_date: string | null
          hourly_task_target: number | null
          id: string
          max_rejection_rate_pct: number | null
          name: string
          project_lead_id: string | null
          quality_target_pct: number | null
          required_headcount: number
          shift: Database["public"]["Enums"]["project_shift"] | null
          start_date: string | null
          status: Database["public"]["Enums"]["project_status"]
          task_unit: string
          updated_at: string
          work_mode: Database["public"]["Enums"]["work_mode"]
        }
        Insert: {
          client_name?: string | null
          code: string
          created_at?: string
          created_by?: string | null
          daily_task_target?: number | null
          description?: string | null
          end_date?: string | null
          hourly_task_target?: number | null
          id?: string
          max_rejection_rate_pct?: number | null
          name: string
          project_lead_id?: string | null
          quality_target_pct?: number | null
          required_headcount?: number
          shift?: Database["public"]["Enums"]["project_shift"] | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          task_unit?: string
          updated_at?: string
          work_mode?: Database["public"]["Enums"]["work_mode"]
        }
        Update: {
          client_name?: string | null
          code?: string
          created_at?: string
          created_by?: string | null
          daily_task_target?: number | null
          description?: string | null
          end_date?: string | null
          hourly_task_target?: number | null
          id?: string
          max_rejection_rate_pct?: number | null
          name?: string
          project_lead_id?: string | null
          quality_target_pct?: number | null
          required_headcount?: number
          shift?: Database["public"]["Enums"]["project_shift"] | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          task_unit?: string
          updated_at?: string
          work_mode?: Database["public"]["Enums"]["work_mode"]
        }
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_project_lead_id_fkey"
            columns: ["project_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      request_approvals: {
        Row: {
          approver_id: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision: Database["public"]["Enums"]["approval_decision"]
          id: string
          note: string | null
          request_id: string
          tier: Database["public"]["Enums"]["approval_tier"]
        }
        Insert: {
          approver_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: Database["public"]["Enums"]["approval_decision"]
          id?: string
          note?: string | null
          request_id: string
          tier: Database["public"]["Enums"]["approval_tier"]
        }
        Update: {
          approver_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: Database["public"]["Enums"]["approval_decision"]
          id?: string
          note?: string | null
          request_id?: string
          tier?: Database["public"]["Enums"]["approval_tier"]
        }
        Relationships: [
          {
            foreignKeyName: "request_approvals_approver_id_fkey"
            columns: ["approver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_approvals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_approvals_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      requests: {
        Row: {
          created_at: string
          day_id: string | null
          decided_at: string | null
          end_date: string
          id: string
          reason: string
          request_type: Database["public"]["Enums"]["request_type"]
          requested_check_in: string | null
          requested_check_out: string | null
          routing_reason: string
          start_date: string
          status: Database["public"]["Enums"]["request_status"]
          submitted_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          day_id?: string | null
          decided_at?: string | null
          end_date: string
          id?: string
          reason: string
          request_type: Database["public"]["Enums"]["request_type"]
          requested_check_in?: string | null
          requested_check_out?: string | null
          routing_reason?: string
          start_date: string
          status?: Database["public"]["Enums"]["request_status"]
          submitted_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          day_id?: string | null
          decided_at?: string | null
          end_date?: string
          id?: string
          reason?: string
          request_type?: Database["public"]["Enums"]["request_type"]
          requested_check_in?: string | null
          requested_check_out?: string | null
          routing_reason?: string
          start_date?: string
          status?: Database["public"]["Enums"]["request_status"]
          submitted_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "requests_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "attendance_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      review_events: {
        Row: {
          action: Database["public"]["Enums"]["review_action"]
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          note: string | null
          reviewer_id: string
          subject_user_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["review_action"]
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          note?: string | null
          reviewer_id: string
          subject_user_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["review_action"]
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          note?: string | null
          reviewer_id?: string
          subject_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_events_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_events_subject_user_id_fkey"
            columns: ["subject_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_key: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          permission_key: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          permission_key?: string
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_key_fkey"
            columns: ["permission_key"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "role_permissions_role_fkey"
            columns: ["role"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["role"]
          },
        ]
      }
      roles: {
        Row: {
          description: string | null
          label: string
          rank: number
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          description?: string | null
          label: string
          rank: number
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          description?: string | null
          label?: string
          rank?: number
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: []
      }
      task_entries: {
        Row: {
          allocation_id: string | null
          created_at: string
          day_id: string
          ended_at: string
          id: string
          project_id: string
          review_note: string | null
          reviewed_at: string | null
          reviewer_id: string | null
          slot_type: Database["public"]["Enums"]["task_slot_type"]
          started_at: string
          status: Database["public"]["Enums"]["task_entry_status"]
          task_description: string
          units_approved: number | null
          units_assigned: number | null
          units_completed: number
          units_rejected: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          allocation_id?: string | null
          created_at?: string
          day_id: string
          ended_at: string
          id?: string
          project_id: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewer_id?: string | null
          slot_type?: Database["public"]["Enums"]["task_slot_type"]
          started_at: string
          status?: Database["public"]["Enums"]["task_entry_status"]
          task_description: string
          units_approved?: number | null
          units_assigned?: number | null
          units_completed?: number
          units_rejected?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          allocation_id?: string | null
          created_at?: string
          day_id?: string
          ended_at?: string
          id?: string
          project_id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewer_id?: string | null
          slot_type?: Database["public"]["Enums"]["task_slot_type"]
          started_at?: string
          status?: Database["public"]["Enums"]["task_entry_status"]
          task_description?: string
          units_approved?: number | null
          units_assigned?: number | null
          units_completed?: number
          units_rejected?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_entries_allocation_id_fkey"
            columns: ["allocation_id"]
            isOneToOne: false
            referencedRelation: "project_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_entries_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "attendance_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_entries_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          granted_at: string
          granted_by: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_job_lease: {
        Args: { _job_name: string; _seconds: number }
        Returns: boolean
      }
      allocation_pct_used: {
        Args: {
          _exclude_allocation?: string
          _on_date?: string
          _user_id: string
        }
        Returns: number
      }
      attendance_day_metrics: {
        Args: { _day_id: string }
        Returns: {
          blocker_minutes: number
          break_minutes: number
          covered_minutes: number
          entry_count: number
          task_minutes: number
          uncovered_minutes: number
          units_completed: number
          unsubmitted_entries: number
          worked_minutes: number
        }[]
      }
      can_log_work: {
        Args: { _on_date?: string; _project_id: string; _user_id: string }
        Returns: boolean
      }
      can_view_project: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      claim_invitations: {
        Args: { _limit: number }
        Returns: {
          accepted_at: string | null
          attempts: number
          batch_id: string | null
          category: Database["public"]["Enums"]["user_category"]
          created_at: string
          created_by: string | null
          department_id: string | null
          designation: string | null
          email: string
          expires_at: string
          full_name: string
          id: string
          invited_user_id: string | null
          last_error: string | null
          metadata: Json
          next_attempt_at: string
          purpose: string
          queued_at: string
          reporting_lead_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          sent_at: string | null
          source: string
          status: Database["public"]["Enums"]["invitation_status"]
          token_hash: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "invitations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      day_targets: {
        Args: { _day_id: string }
        Returns: {
          daily_task_target: number
          hourly_task_target: number
          max_rejection_rate_pct: number
          project_code: string
          quality_target_pct: number
        }[]
      }
      derive_attendance_status: {
        Args: { _day_id: string }
        Returns: Database["public"]["Enums"]["attendance_status"]
      }
      has_permission: {
        Args: { _permission: string; _user_id: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_allocated_to_project: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      is_project_lead: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      is_reporting_lead_of: {
        Args: { _lead_id: string; _user_id: string }
        Returns: boolean
      }
      is_work_lead_of: {
        Args: { _owner: string; _viewer: string }
        Returns: boolean
      }
      my_permissions: {
        Args: never
        Returns: {
          permission_key: string
        }[]
      }
      profile_names: {
        Args: { _ids: string[] }
        Returns: {
          designation: string
          full_name: string
          id: string
        }[]
      }
      release_job_lease: { Args: { _job_name: string }; Returns: undefined }
    }
    Enums: {
      account_status:
        | "invited"
        | "activated"
        | "profile_pending"
        | "under_verification"
        | "active"
      allocation_status:
        | "pending_acknowledgment"
        | "active"
        | "paused"
        | "ended"
      app_role: "super_admin" | "founder" | "hr" | "admin" | "lead" | "employee"
      approval_decision: "pending" | "approved" | "rejected"
      approval_tier: "lead" | "hr"
      attendance_status:
        | "present_complete"
        | "present_hours_incomplete"
        | "present_eod_pending"
        | "half_day"
        | "missed_check_out"
        | "absent"
        | "on_leave"
        | "holiday"
        | "weekly_off"
        | "review_required"
      attendance_work_mode:
        | "wfo"
        | "wfh"
        | "hybrid"
        | "client_location"
        | "field_work"
      blocker_category:
        | "data_quality"
        | "tooling"
        | "access"
        | "dependency"
        | "guidance"
        | "client"
        | "personal"
        | "other"
      blocker_severity: "low" | "medium" | "high" | "critical"
      blocker_status: "open" | "acknowledged" | "resolved"
      break_category:
        | "lunch"
        | "short_break"
        | "personal"
        | "meeting"
        | "training"
        | "other"
      day_exception: "none" | "leave" | "holiday" | "weekly_off"
      document_status: "pending" | "verified" | "rejected"
      document_type:
        | "resume"
        | "identity_proof"
        | "pan"
        | "bank_details"
        | "education"
        | "offer_letter"
        | "nda"
        | "other"
      employment_status: "active" | "inactive" | "on_hold" | "exited"
      eod_status:
        | "draft"
        | "submitted"
        | "reviewed"
        | "approved"
        | "revision_required"
        | "escalated"
        | "performance_concern"
      invitation_status:
        | "queued"
        | "sending"
        | "sent"
        | "failed"
        | "accepted"
        | "revoked"
      project_shift:
        | "general"
        | "morning"
        | "evening"
        | "night"
        | "rotational"
        | "flexible"
      project_status: "draft" | "active" | "on_hold" | "completed" | "archived"
      request_status: "pending" | "approved" | "rejected" | "cancelled"
      request_type: "leave" | "wfh" | "attendance_correction"
      review_action:
        | "approved"
        | "approved_with_comment"
        | "revision_requested"
        | "escalated"
        | "performance_concern"
      task_entry_status:
        | "draft"
        | "submitted"
        | "reviewed"
        | "revision_required"
        | "approved"
      task_slot_type: "fixed" | "flexible"
      user_category: "full_time" | "intern" | "freelancer" | "trainer"
      work_mode: "onsite" | "remote" | "hybrid"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: [
        "invited",
        "activated",
        "profile_pending",
        "under_verification",
        "active",
      ],
      allocation_status: [
        "pending_acknowledgment",
        "active",
        "paused",
        "ended",
      ],
      app_role: ["super_admin", "founder", "hr", "admin", "lead", "employee"],
      approval_decision: ["pending", "approved", "rejected"],
      approval_tier: ["lead", "hr"],
      attendance_status: [
        "present_complete",
        "present_hours_incomplete",
        "present_eod_pending",
        "half_day",
        "missed_check_out",
        "absent",
        "on_leave",
        "holiday",
        "weekly_off",
        "review_required",
      ],
      attendance_work_mode: [
        "wfo",
        "wfh",
        "hybrid",
        "client_location",
        "field_work",
      ],
      blocker_category: [
        "data_quality",
        "tooling",
        "access",
        "dependency",
        "guidance",
        "client",
        "personal",
        "other",
      ],
      blocker_severity: ["low", "medium", "high", "critical"],
      blocker_status: ["open", "acknowledged", "resolved"],
      break_category: [
        "lunch",
        "short_break",
        "personal",
        "meeting",
        "training",
        "other",
      ],
      day_exception: ["none", "leave", "holiday", "weekly_off"],
      document_status: ["pending", "verified", "rejected"],
      document_type: [
        "resume",
        "identity_proof",
        "pan",
        "bank_details",
        "education",
        "offer_letter",
        "nda",
        "other",
      ],
      employment_status: ["active", "inactive", "on_hold", "exited"],
      eod_status: [
        "draft",
        "submitted",
        "reviewed",
        "approved",
        "revision_required",
        "escalated",
        "performance_concern",
      ],
      invitation_status: [
        "queued",
        "sending",
        "sent",
        "failed",
        "accepted",
        "revoked",
      ],
      project_shift: [
        "general",
        "morning",
        "evening",
        "night",
        "rotational",
        "flexible",
      ],
      project_status: ["draft", "active", "on_hold", "completed", "archived"],
      request_status: ["pending", "approved", "rejected", "cancelled"],
      request_type: ["leave", "wfh", "attendance_correction"],
      review_action: [
        "approved",
        "approved_with_comment",
        "revision_requested",
        "escalated",
        "performance_concern",
      ],
      task_entry_status: [
        "draft",
        "submitted",
        "reviewed",
        "revision_required",
        "approved",
      ],
      task_slot_type: ["fixed", "flexible"],
      user_category: ["full_time", "intern", "freelancer", "trainer"],
      work_mode: ["onsite", "remote", "hybrid"],
    },
  },
} as const
