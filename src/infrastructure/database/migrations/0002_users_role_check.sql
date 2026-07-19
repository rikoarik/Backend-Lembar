ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" in ('superadmin','school_admin','teacher','subscriber'));
