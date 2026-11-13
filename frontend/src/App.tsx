import { Navigate, Route, Routes } from "react-router-dom";
import { useApp } from "./lib/app";
import { Layout } from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import { JobDetail, Jobs, Runs } from "./pages/Jobs";
import { CopyJobPage, EditJobPage, NewJobPage } from "./modals/JobEditor";
import { NewPlaybookPage } from "./pages/PlaybookEditor";
import { Inventory, Keys, Registries, Repos, Webhooks } from "./pages/Resources";
import Envs from "./pages/Envs";
import { Activity, Members, Notify, Security } from "./pages/Admin";
import Notes from "./pages/Notes";
import Login from "./pages/Login";

export default function App() {
  const { session } = useApp();
  if (!session) return null;
  if (!session.loggedIn) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/new" element={<NewJobPage />} />
        <Route path="/jobs/new-playbook" element={<NewPlaybookPage />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/jobs/:id/edit" element={<EditJobPage />} />
        <Route path="/jobs/:id/copy" element={<CopyJobPage />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/registries" element={<Registries />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/repos" element={<Repos />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/keys" element={<Keys />} />
        <Route path="/envs" element={<Envs />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/members" element={<Members />} />
        <Route path="/security" element={<Security />} />
        <Route path="/notify" element={<Notify />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
